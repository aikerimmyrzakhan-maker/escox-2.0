# filters.py
from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, Any, List, Optional, Set
import os
import pandas as pd
from . import SkillExtractor


@dataclass
class SkillIndex:
    by_id: Dict[str, Dict[str, Any]]
    all_types: List[str]

#Build a skill index from the CSV file in the data directory
def build_skill_index(data_dir: str) -> SkillIndex:
    path = os.path.join(data_dir, "skills_en.csv")
    df = pd.read_csv(path, dtype=str, encoding="utf-8").fillna("")

    
    if "conceptUri" not in df.columns:
        raise ValueError("skills_en.csv must contain conceptUri")
    if "preferredLabel" not in df.columns:
        raise ValueError("skills_en.csv must contain preferredLabel")
    if "altLabels" not in df.columns:
        raise ValueError("skills_en.csv must contain altLabels")
    if "skillType" not in df.columns:
        raise ValueError("skills_en.csv must contain skillType")

    by_id: Dict[str, Dict[str, Any]] = {}
    types = set()

    #for each row in the CSV, extract the skill ID, label, alt labels, and type, and store them in a dictionary
    for _, r in df.iterrows():
        sid = str(r["conceptUri"]).strip()
        if not sid:
            continue

        label = str(r["preferredLabel"]).strip()
        alt = str(r["altLabels"]).strip()
        stype = str(r["skillType"]).strip()

        if stype:
            types.add(stype)

        by_id[sid] = {
            "label": label,
            "altLabels": alt,
            "skillType": stype,
        }

    return SkillIndex(by_id=by_id, all_types=sorted(types))

#a function to check if a skill matches a query string, based on its label and alternative labels
def _matches_query(label: str, alt: str, q: str) -> bool:
    if not q:
        return True
    q = q.lower().strip()
    return (q in (label or "").lower()) or (q in (alt or "").lower())

#a function to filter a list of extracted skills based on a query string, skill type, and tags
def filter_extracted(
    extracted: List[Dict[str, Any]],
    index: SkillIndex,
    query: str = "",
    skill_type: str = "ALL",
    tags: Optional[Set[str]] = None,  
) -> List[Dict[str, Any]]:
    tags = tags or set()
    q = (query or "").strip()

    out: List[Dict[str, Any]] = []

    for s in extracted:
        sid = s.get("id")
        meta = index.by_id.get(sid, {})
        stype = meta.get("skillType", "") or ""

        # add skillType into each extracted skill 
        s2 = dict(s)
        s2["skillType"] = stype

        # filter by type
        if skill_type and skill_type != "ALL" and stype != skill_type:
            continue

        # filter by tags
        if "DIGITAL" in tags and not s2.get("digital", False):
            continue
        if "GREEN" in tags and not s2.get("green", False):
            continue

        # search in label + altLabels
        label = s2.get("label", "") or meta.get("label", "")
        alt = meta.get("altLabels", "")
        if not _matches_query(label, alt, q):
            continue

        out.append(s2)

    return out