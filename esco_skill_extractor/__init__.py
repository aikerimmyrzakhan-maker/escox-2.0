from __future__ import annotations

from typing import List, Dict, Optional, Union
import warnings
import pickle
import os
import re

import numpy as np
import pandas as pd
import torch
from sentence_transformers import SentenceTransformer, util



class SkillExtractor:
    _dir = os.path.dirname(__file__)

    def __init__(
        self,
        model: str = "all-MiniLM-L6-v2",
        skills_threshold: float = 0.6,
        occupation_threshold: float = 0.55,
        device: Optional[str] = None,
        use_cache: bool = True,
        hierarchy_match_threshold: float = 0.30,
    ) -> None:
        self.model_name = model
        self.skills_threshold = float(skills_threshold)
        self.skills_threshold_loose = 0.55  
        self.occupation_threshold = float(occupation_threshold)
        self.hierarchy_match_threshold = float(hierarchy_match_threshold)
        self.use_cache = bool(use_cache)

        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")

        # tags
        self._green_skill_ids: set[str] = set()
        self._digital_skill_ids: set[str] = set()

        # load pipeline
        self._load_model()

        self._load_skills()
        self._load_skill_hierarchy()
        self._load_skill_tags()

        self._load_occupations()

        self._create_skill_embeddings()
        self._create_hierarchy_embeddings()
        self._create_occupation_embeddings()

    # ---------------- MODEL ----------------
    def _load_model(self) -> None:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self._model = SentenceTransformer(self.model_name, device=self.device)

    # ---------------- TAGS ----------------
    def _load_skill_tags(self) -> None:
        data_dir = os.path.join(SkillExtractor._dir, "data")
        digital_file = os.path.join(data_dir, "digital_skills.csv")
        green_file = os.path.join(data_dir, "green_skills.csv")

        def load_uris(path: str) -> set[str]:
            if not os.path.exists(path):
                return set()
            df = pd.read_csv(path, dtype=str, encoding="utf-8-sig").fillna("")
            uri_col = next(
                (c for c in df.columns if "conceptUri" in c or "uri" in c.lower()),
                df.columns[0],
            )
            uris = df[uri_col].astype(str).str.strip()
            return set(u for u in uris if u.startswith("http"))

        self._digital_skill_ids = load_uris(digital_file)
        self._green_skill_ids = load_uris(green_file)

    def _is_green(self, skill_id: str) -> bool:
        return skill_id in self._green_skill_ids

    def _is_digital(self, skill_id: str) -> bool:
        return skill_id in self._digital_skill_ids

    # ---------------- SKILLS ----------------
    def _load_skills(self) -> None:
        path = os.path.join(SkillExtractor._dir, "data", "skills_en.csv")
        self._skills = pd.read_csv(path, encoding="utf-8", dtype=str).fillna("")

        if "conceptUri" not in self._skills.columns:
            raise ValueError("skills_en.csv must contain a 'conceptUri' column")

        self._skills["id"] = self._skills["conceptUri"].astype(str)
        self._skill_ids: np.ndarray = self._skills["id"].to_numpy()

        # label column
        self._skills_label_col = next(
            (c for c in ["preferredLabel", "label", "name", "title", "enLabel"] if c in self._skills.columns),
            None,
        )

        # description column used for embeddings
        if "description" in self._skills.columns and self._skills["description"].str.strip().any():
            self._skills_desc_col = "description"
        elif self._skills_label_col:
            self._skills_desc_col = self._skills_label_col
        else:
            self._skills_desc_col = "id"

        # fast lookup tables
        self._skills_by_id = self._skills.set_index("id", drop=False)

    # ---------------- SKILL HIERARCHY ----------------
    def _load_skill_hierarchy(self) -> None:
        """
        Loads hierarchy paths from skillsHierarchy_en.csv.
        We store:
          - self._hier_paths: list[list[str]]  (full path)
          - self._hier_leaf_labels: list[str]  (leaf label for embedding match)
        """
        path = os.path.join(SkillExtractor._dir, "data", "skillsHierarchy_en.csv")
        self._hier_paths: List[List[str]] = []
        self._hier_leaf_labels: List[str] = []

        if not os.path.exists(path):
            self._hier_df = None
            return

        df = pd.read_csv(path, encoding="utf-8", dtype=str).fillna("")
        self._hier_df = df

        term_cols = [
            "Level 0 preferred term",
            "Level 1 preferred term",
            "Level 2 preferred term",
            "Level 3 preferred term",
        ]

        paths: List[List[str]] = []
        leaf_labels: List[str] = []

        for _, row in df.iterrows():
            terms = [str(row.get(c, "")).strip() for c in term_cols]
            terms = [t for t in terms if t]
            if not terms:
                continue
            paths.append(terms)
            leaf_labels.append(terms[-1])

        # de-duplicate by normalized path
        uniq: Dict[str, tuple[List[str], str]] = {}
        for p, leaf in zip(paths, leaf_labels):
            key = " > ".join(p).lower()
            if key not in uniq:
                uniq[key] = (p, leaf)

        self._hier_paths = [v[0] for v in uniq.values()]
        self._hier_leaf_labels = [v[1] for v in uniq.values()]

        print("✅ hierarchy path:", path)
        print("✅ hierarchy exists:", os.path.exists(path))


        #----------- SKILL SIMILARITY  -------------
    def get_similar_skills(self, skill_id: str, top_k: int = 5):
        if skill_id not in self._skills_by_id.index:
            return []

        idx = list(self._skill_ids).index(skill_id)
        query_emb = self._skill_embeddings[idx].unsqueeze(0)

        sim = util.dot_score(query_emb, self._skill_embeddings)[0]

        # get top similar (excluding itself)
        top_idx = torch.topk(sim, k=top_k + 1).indices.tolist()

        results = []
        for i in top_idx:
            sid = self._skill_ids[i]
            if sid == skill_id:
                continue
            results.append(sid)

        return self.resolve_skill_labels(results[:top_k])



    # ------------- OCCUPATIONS -------------
    def _load_occupations(self) -> None:
        path = os.path.join(SkillExtractor._dir, "data", "occupations_en.csv")
        if not os.path.exists(path):
            path = os.path.join(SkillExtractor._dir, "data", "occupations.csv")

        self._occupations = pd.read_csv(path, encoding="utf-8", dtype=str).fillna("")

        if "conceptUri" in self._occupations.columns:
            self._occupations["id"] = self._occupations["conceptUri"].astype(str)
        elif "id" in self._occupations.columns:
            self._occupations["id"] = self._occupations["id"].astype(str)
        else:
            raise ValueError("Occupations file must contain either 'conceptUri' or 'id'")

        self._occupation_ids: np.ndarray = self._occupations["id"].to_numpy()

        self._occupations_label_col = next(
            (c for c in ["preferredLabel", "label", "name", "title", "enLabel"] if c in self._occupations.columns),
            None,
        )

        if "description" in self._occupations.columns and self._occupations["description"].str.strip().any():
            self._occupations_desc_col = "description"
        elif self._occupations_label_col:
            self._occupations_desc_col = self._occupations_label_col
        else:
            self._occupations_desc_col = "id"

        self._occupations_by_id = self._occupations.set_index("id", drop=False)

    # -------------- EMBEDDINGS --------------
    def _encode_texts(self, texts: List[str]) -> torch.Tensor:
        return self._model.encode(
            texts,
            device=self.device,
            normalize_embeddings=True,
            convert_to_tensor=True,
            show_progress_bar=False,
        )

    def _load_cached_tensor(self, path: str) -> Optional[torch.Tensor]:
        if not self.use_cache:
            return None
        if not os.path.exists(path):
            return None
        try:
            with open(path, "rb") as f:
                t = pickle.load(f)
            # ensure tensor on correct device
            if isinstance(t, torch.Tensor):
                return t.to(self.device)
        except Exception:
            return None
        return None

    def _save_cached_tensor(self, path: str, tensor: torch.Tensor) -> None:
        if not self.use_cache:
            return
        try:
            with open(path, "wb") as f:
                # store cpu tensor for portability
                pickle.dump(tensor.detach().cpu(), f)
        except Exception:
            pass

    def _create_skill_embeddings(self) -> None:
        cache = os.path.join(SkillExtractor._dir, "data", "skill_embeddings.bin")
        cached = self._load_cached_tensor(cache)
        if cached is not None:
            self._skill_embeddings = cached
            return

        # Use labels only, not descriptions, matches better against short input
        texts = self._skills[self._skills_label_col].astype(str).tolist()
        self._skill_embeddings = self._encode_texts(texts)
        self._save_cached_tensor(cache, self._skill_embeddings)

        texts = self._skills[self._skills_desc_col].astype(str).tolist()
        self._skill_embeddings = self._encode_texts(texts)
        self._save_cached_tensor(cache, self._skill_embeddings)

    def _create_hierarchy_embeddings(self) -> None:
        """
        Encodes hierarchy leaf labels into embeddings so we can map skill to closest category path.
        """
        if not self._hier_leaf_labels:
            self._hier_embeddings = None
            return

        cache = os.path.join(SkillExtractor._dir, "data", "hierarchy_embeddings.bin")
        cached = self._load_cached_tensor(cache)
        if cached is not None:
            self._hier_embeddings = cached
            return

        self._hier_embeddings = self._encode_texts(self._hier_leaf_labels)
        self._save_cached_tensor(cache, self._hier_embeddings)

    def _create_occupation_embeddings(self) -> None:
        cache = os.path.join(SkillExtractor._dir, "data", "occupation_embeddings.bin")
        cached = self._load_cached_tensor(cache)
        if cached is not None:
            self._occupation_embeddings = cached
            return

        texts = self._occupations[self._occupations_desc_col].astype(str).tolist()
        self._occupation_embeddings = self._encode_texts(texts)
        self._save_cached_tensor(cache, self._occupation_embeddings)

    # ----------- CORE ENTITY MATCHING --------
    def _get_entity(self, texts, entity_ids, entity_embeddings, threshold):
        if all(not (t or "").strip() for t in texts):
            return [[] for _ in texts]

        sent_emb = self._encode_texts(texts)
        sim = util.dot_score(sent_emb, entity_embeddings)

        results = []
        for i in range(len(texts)):
            above = (sim[i] > threshold).nonzero(as_tuple=True)[0].tolist()
            results.append([entity_ids[idx] for idx in above])
        return results

    # ----------- HIERARCHY MAPPING -----------
    def _best_hierarchy_path_for_skill_label(self, skill_label: str) -> List[str]:
        """
        Returns a hierarchy path like:
          ["skills", "working with computers", "programming computer systems"]
        If hierarchy is missing or match confidence is low -> []
        """
        if not skill_label or self._hier_embeddings is None or not self._hier_paths:
            return []

        q = self._encode_texts([skill_label])
        sim = util.dot_score(q, self._hier_embeddings)  
        best_idx = int(torch.argmax(sim, dim=1).item())
        best_score = float(sim[0, best_idx].item())

        if best_score < self.hierarchy_match_threshold:
            return []

        return self._hier_paths[best_idx]

    # ----------- LABEL RESOLVERS -----------
    def resolve_skill_labels(self, ids: List[str]) -> List[Dict[str, object]]:
        out = []
        for i in ids:
            if i not in self._skills_by_id.index:
                continue  # skip unknown ids
                
            row = self._skills_by_id.loc[i]
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]

            label = str(row.get(self._skills_label_col, "")).strip() if self._skills_label_col else ""
            description = str(row.get("description", "")).strip()

            if not label:
                label = i.rsplit("/", 1)[-1]
            if not description:
                description = f"{label} is a professional ESCO skill."

            path = self._best_hierarchy_path_for_skill_label(label)

            out.append({
                "id": i,
                "label": label,
                "description": description,
                "green": self._is_green(i),
                "digital": self._is_digital(i),
                "path": path,
            })
        return out

    def resolve_occupation_labels(self, ids: List[str]) -> List[Dict[str, object]]:
        out: List[Dict[str, object]] = []
        for i in ids:
            label = ""
            if i in self._occupations_by_id.index and self._occupations_label_col:
                label = str(self._occupations_by_id.at[i, self._occupations_label_col]).strip() or ""
            if not label:
                label = i.rsplit("/", 1)[-1]
            out.append({"id": i, "label": label})
        return out

    # --------------- PUBLIC API ---------------
    def get_skills(self, texts: List[str]) -> List[List[str]]:
        return self._get_entity(texts, self._skill_ids, self._skill_embeddings, self.skills_threshold)

    def get_occupations(self, texts: List[str]) -> List[List[str]]:
        return self._get_entity(texts, self._occupation_ids, self._occupation_embeddings, self.occupation_threshold)

    def extract_and_classify(self, text: Union[str, List[str]]) -> List[Dict[str, object]]:
        texts = text if isinstance(text, list) else [text]
        all_ids: List[str] = []

        for t in texts:
            t = (t or "").strip()
            if not t:
                continue

            ids = self._get_entity([t], self._skill_ids, self._skill_embeddings, self.skills_threshold_loose)[0]
            all_ids.extend(ids)  

        all_ids = list(dict.fromkeys(all_ids))

        resolved = self.resolve_skill_labels(all_ids)
        for s in resolved:
            s["similar"] = self.get_similar_skills(s["id"])

        for s in resolved:
            if s.get("green"):
                s["category"] = "GREEN"
            elif s.get("digital"):
                s["category"] = "DIGITAL"
            else:
                s["category"] = "OTHER"

        return resolved