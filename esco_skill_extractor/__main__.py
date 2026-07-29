import argparse
import os
from pydoc import text
import re
import pandas as pd

from flask import Flask, render_template, request, jsonify
from waitress import serve
from difflib import SequenceMatcher

from . import SkillExtractor
import inspect
from .filters import build_skill_index, filter_extracted


from io import BytesIO
from PyPDF2 import PdfReader
from docx import Document

from flask import session, redirect
from werkzeug.security import generate_password_hash, check_password_hash
from functools import wraps
from datetime import datetime
import json
from .db import db, User, SavedItem, SgaAnalysis

import os

#python -m esco_skill_extractor --host localhost --port 8000
#This command is used to start a web application from the terminal using Python.


# ----- CLI ----- #
parser = argparse.ArgumentParser(
    description="ESCO Skill Extractor: Extract ESCO skills and ISCO occupations from any text."
)
parser.add_argument("--model", "-m", type=str, default="all-MiniLM-L6-v2")
parser.add_argument("--skill_threshold", "-s", type=float, default=0.6)
parser.add_argument("--occupation_threshold", "-o", type=float, default=0.55)
parser.add_argument("--device", "-d", type=str, default=None)
parser.add_argument("--host", "-c", type=str, default="localhost")
parser.add_argument("--port", "-p", type=int, default=8000)
args = parser.parse_args()

# ----- Extractor ----- #
extractor = SkillExtractor(
    model=args.model,
    skills_threshold=args.skill_threshold,
    occupation_threshold=args.occupation_threshold,
    device=args.device,
)

# ----- Flask ----- #
BASE_DIR = os.path.dirname(__file__)
app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)

app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-CHANGE-in-prod")
app.config["SQLALCHEMY_DATABASE_URI"] = (
    f"sqlite:///{os.path.join(BASE_DIR, 'userdata.db')}"
    )
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
db.init_app(app)

with app.app_context():
    db.create_all()

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
SKILL_INDEX = build_skill_index(DATA_DIR)



def _load_csv_safe(path):
    try:
        return pd.read_csv(path, dtype=str, encoding="utf-8-sig").fillna("")
    except Exception as e:
        print(f"Warning: could not load {path}: {e}")
        return pd.DataFrame()



_occ_df  = _load_csv_safe(os.path.join(DATA_DIR, "occupations_en.csv"))
_isco_df = _load_csv_safe(os.path.join(DATA_DIR, "ISCOGroups_en.csv"))
_rel_df  = _load_csv_safe(os.path.join(DATA_DIR, "occupationSkillRelations_en.csv"))

_occ_by_uri  = _occ_df.set_index("conceptUri",  drop=False) if "conceptUri"   in _occ_df.columns  else pd.DataFrame()
_isco_by_uri = _isco_df.set_index("conceptUri", drop=False) if "conceptUri"   in _isco_df.columns  else pd.DataFrame()
_isco_by_code= _isco_df.set_index("code",       drop=False) if "code"         in _isco_df.columns  else pd.DataFrame()




def _build_isco_path(isco_code: str) -> list:

    if not isco_code or _isco_by_code.empty:
        return []

    code = str(isco_code).strip()
    path = []
    ancestors = [code[:i] for i in range(1, len(code) + 1)]

    for ancestor in ancestors:
        if ancestor in _isco_by_code.index:
            row = _isco_by_code.loc[ancestor]
            # .loc can return a Series (single) or DataFrame (multiple) if duplicates
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            label = str(row.get("preferredLabel", "")).strip()
            if label:
                path.append(label)

    return path


def _get_occupation_skills(occ_uri: str) -> dict:

    if _rel_df.empty:
        return {"essential": [], "optional": []}

    rows = _rel_df[_rel_df["occupationUri"] == occ_uri]

    essential = []
    optional  = []

    for _, r in rows.iterrows():
        skill = {
            "label": str(r.get("skillLabel", "")).strip(),
            "uri":   str(r.get("skillUri",   "")).strip(),
            "type":  str(r.get("skillType",  "")).strip(),  
        }
        if not skill["label"]:
            continue
        relation = str(r.get("relationType", "")).strip().lower()
        if relation == "essential":
            essential.append(skill)
        else:
            optional.append(skill)

    return {"essential": essential, "optional": optional}


def _build_occupation_detail(occ_uri: str) -> dict | None:

    if _occ_by_uri.empty or occ_uri not in _occ_by_uri.index:
        return None

    row = _occ_by_uri.loc[occ_uri]
    if isinstance(row, pd.DataFrame):
        row = row.iloc[0]

    isco_code   = str(row.get("iscoGroup", "")).strip()
    alt_raw     = str(row.get("altLabels", "")).strip()
    alt_labels  = [a.strip() for a in alt_raw.splitlines() if a.strip()] if alt_raw else []

    return {
        "id":          occ_uri,
        "label":       str(row.get("preferredLabel", "")).strip(),
        "description": str(row.get("description",   "")).strip(),
        "iscoGroup":   isco_code,
        "iscoPath":    _build_isco_path(isco_code),
        "altLabels":   alt_labels,
        "skills":      _get_occupation_skills(occ_uri),
    }

@app.route("/occupation-details", methods=["POST"])
def occupation_details():
    """
    POST { "uri": "http://data.europa.eu/esco/occupation/..." }
    Returns full detail object for that occupation.
    """
    data = request.get_json(silent=True) or {}
    uri  = (data.get("uri") or "").strip()

    if not uri:
        return jsonify({"error": "uri required"}), 400

    detail = _build_occupation_detail(uri)
    if not detail:
        return jsonify({"error": "Occupation not found"}), 404

    return jsonify(detail)


@app.route("/search-occupations", methods=["POST"])
def search_occupations():
    data  = request.get_json(silent=True) or {}
    query = (data.get("query") or "").strip()
    limit = int(data.get("limit", 20))

    if not query or _occ_by_uri.empty:
        return jsonify([])

    keyword_results = []
    q = query.lower()
    for _, row in _occ_df.iterrows():
        label = str(row.get("preferredLabel", "")).strip()
        alts  = str(row.get("altLabels", "")).strip().lower()
        uri   = str(row.get("conceptUri", "")).strip()
        if q in label.lower() or q in alts:
            keyword_results.append({"id": uri, "label": label})
        if len(keyword_results) >= limit:
            break

    if keyword_results:
        return jsonify(keyword_results)

    # Fallback: semantic search using the extractor
    ids = extractor.get_occupations([query])[0]
    
    # If below threshold, force best match anyway
    if not ids:
        from sentence_transformers import util
        import torch
        query_emb = extractor._encode_texts([query])
        sim = util.dot_score(query_emb, extractor._occupation_embeddings)
        top_k = min(limit, len(extractor._occupation_ids))
        top_indices = torch.topk(sim[0], k=top_k).indices.tolist()
        ids = [extractor._occupation_ids[i] for i in top_indices]

    results = []
    for uid in ids[:limit]:
        detail = _build_occupation_detail(uid)
        if detail:
            results.append({"id": detail["id"], "label": detail["label"]})
        else:
            resolved = extractor.resolve_occupation_labels([uid])
            if resolved:
                results.append(resolved[0])

    return jsonify(results)


@app.route("/extract-occupations", methods=["POST"])
def extract_occupations():
    """
    Override the original simple extractor to return enriched objects.
    POST [ "text1", "text2", ... ]
    """
    texts = request.get_json(silent=True) or []

    # get IDs from extractor (existing logic)
    ids_per_text = extractor.get_occupations(texts)
    all_ids = list(dict.fromkeys(
        uid for group in ids_per_text for uid in group
    ))

    results = []
    for uid in all_ids:
        detail = _build_occupation_detail(uid)
        if detail:
            results.append(detail)
        else:
            # fallback: just label from extractor
            resolved = extractor.resolve_occupation_labels([uid])
            if resolved:
                results.append(resolved[0])

    return jsonify(results)

@app.after_request
def handle_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Requested-With"
    return response

@app.route("/")
def index():
    return render_template("index.html", host=args.host, port=args.port)

@app.route("/skills")
def skills_page():
    print("TEMPLATE PATH:", os.getcwd(), flush=True)
    return render_template("skills.html", host=args.host, port=args.port)

@app.route("/sga")  
def skill_page():
    return render_template("sga.html", host=args.host, port=args.port)

@app.route("/occupations")  
def occupations_page():
    return render_template("occupations.html", host=args.host, port=args.port)
    

# Skills Extraction API
@app.route("/extract-skills", methods=["POST"])
def extract_skills():
    texts = request.json
    results = []

    for text in texts:
        text = (text or "").strip()
        if not text:
            continue

        if text.lower() == "sql":
            results.append({
                "id": "http://data.europa.eu/esco/skill/598de5b0-5b58-4ea7-8058-a4bc4d18c742",
                "label": "SQL",
                "digital": True,
                "green": False,
                "path": extractor._best_hierarchy_path_for_skill_label("SQL"),
            })
            continue

        items = extractor.extract_and_classify(text)
        for s in items:
            if "path" not in s or not isinstance(s.get("path"), list):
                s["path"] = extractor._best_hierarchy_path_for_skill_label(s.get("label", ""))
            if not s.get("description"):
                s["description"] = f"{s.get('label', 'This')} is a professional ESCO skill."
        results.extend(items)

    uniq = {}
    for s in results:
        uniq[s["id"]] = s

    return jsonify(list(uniq.values()))

# ----- Skill Gap Analysis ----- #
# New API: Extract skills from uploaded file (CV, job description, etc.) 
@app.route("/extract-skills-from-file", methods=["POST"])
def extract_skills_from_file():
    try:
        if "file" not in request.files:
            return jsonify({"error": "No file uploaded"}), 400

        file = request.files["file"]
        if not file or not file.filename:
            return jsonify({"error": "Empty file"}), 400

        filename = file.filename.lower()
        text = ""

        if filename.endswith(".txt"):
            text = file.read().decode("utf-8", errors="ignore")

        elif filename.endswith(".pdf"):
            reader = PdfReader(BytesIO(file.read()))
            pages = []
            for page in reader.pages:
                pages.append(page.extract_text() or "")
            text = "\n".join(pages)

        elif filename.endswith(".docx"):
            doc = Document(BytesIO(file.read()))
            text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())

        else:
            return jsonify({"error": "Unsupported file type. Use PDF, DOCX, or TXT."}), 400

        if not text.strip():
            return jsonify({"error": "Could not extract text from file."}), 400

        parts = extract_candidate_phrases_from_file(text)
        results = []

        for p in parts:
            items = extractor.extract_and_classify(p)

            for s in items:
                if "path" not in s or not isinstance(s.get("path"), list):
                    s["path"] = extractor._best_hierarchy_path_for_skill_label(
                        s.get("label", "")
                    )

            results.extend(items)

        uniq = {}
        for s in results:
            uniq[s["id"]] = s

        return jsonify({
            "text": text,
            "skills": list(uniq.values())
        })

    except Exception as e:
        import traceback
        return jsonify({
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500

FILLER = re.compile(
    r"\b(i\s+know|i\s+have|i\s+need\s+to|i\s+have\s+to|i\s+must|familiar\s+with|experienced\s+in|skills?\s*:|required\s*:?)\b",
    flags=re.IGNORECASE
)

# Keep symbol skills safe
SYMBOL_SKILLS = re.compile(r"(?<!\w)(c\+\+|c#|\.net|node\.js)(?!\w)", flags=re.IGNORECASE)

def extract_candidate_phrases(text: str) -> list[str]:
    """
    Turn ANY free text into candidate skill phrases.
    We will still map these candidates to ESCO using the extractor.
    """
    text = (text or "").strip()
    if not text:
        return []

    # normalize separators
    text = text.replace("\r", "\n").replace("\t", " ")
    text = re.sub(r"[|•]", " ", text)

    # remove filler words
    text = FILLER.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()

    low = text.lower()
    specials = [m.group(0) for m in SYMBOL_SKILLS.finditer(low)]

    cleaned = low
    for sp in set(specials):
        cleaned = re.sub(re.escape(sp), " ", cleaned)

    chunks = re.split(r"[,;\n]|\band\b", cleaned, flags=re.IGNORECASE)
    chunks = [c.strip() for c in chunks if c.strip()]

    candidates = set()

    for ch in chunks:
        words = ch.split()
        if len(words) >= 2 and all(len(w) <= 8 for w in words):
            candidates.update(words)
            # looks like a list of short skills: "java sql c++"
            for w in words:
                candidates.add(w)
        else:
            # keep phrase intact: "data analysis"
            candidates.add(ch)

    for sp in specials:
        candidates.add(sp.lower())

    # normalize common aliases
    alias = {"js": "javascript", "ts": "typescript", "cpp": "c++"}
    out = [alias.get(c, c) for c in candidates if c]

    # stable order: longer phrases first (helps ESCO match phrases)
    out.sort(key=lambda x: (-len(x.split()), x))
    return out

def extract_candidate_phrases_from_file(text: str) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []

    text = text.replace("\r", "\n").replace("\t", " ")
    text = re.sub(r"[|•·\-]", "\n", text)
    text = FILLER.sub(" ", text)
    # Only collapse spaces, preserve newlines
    text = re.sub(r" +", " ", text).strip()  

    ACTION_VERBS = re.compile(
        r"^(design|implement|build|develop|manage|monitor|ensure|apply|write|create|"
        r"collaborate|analyse|analyze|deploy|maintain|prepare|coordinate|support|"
        r"troubleshoot|optimize|follow|assess|define|identify|report|conduct|use|"
        r"provide|perform|review|plan|deliver|work|lead|establish|handle|operate)\b",
        flags=re.IGNORECASE
    )

    chunks = re.split(r"[\n,;]", text)
    chunks = [c.strip() for c in chunks if c.strip()]

    candidates = set()
    for ch in chunks:
        if len(ch) < 3:
            continue
        words = ch.split()
        if len(words) > 5:
            continue
        if ch.isdigit():
            continue
        if ACTION_VERBS.match(ch):
            continue
        candidates.add(ch.lower())

    for m in SYMBOL_SKILLS.finditer(text.lower()):
        candidates.add(m.group(0))

    alias = {"js": "javascript", "ts": "typescript", "cpp": "c++"}
    out = [alias.get(c, c) for c in candidates if c]
    out.sort(key=lambda x: (-len(x.split()), x))
    return out

def similarity(a: str, b: str) -> float:
    a = (a or "").lower().strip()
    b = (b or "").lower().strip()
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()

def as_text(x) -> str:
    if x is None:
        return ""
    if isinstance(x, list):
        return ", ".join(str(i).strip() for i in x if str(i).strip())
    return str(x)


def safe_extract_skills(candidates):
    try:
        if not candidates:
            return []
        results = extractor.extract_and_classify(candidates)
        candidates_lower = [c.lower() for c in candidates]
        
        def has_overlap(skill_label):
            label_words = set(skill_label.lower().split())
            stop = {'a','an','the','in','of','to','and','or','for','with','on','at','out','up'}
            label_words -= stop
            if not label_words:
                return True
            
            all_candidate_words = set()
            for cand in candidates_lower:
                all_candidate_words.update(set(cand.split()) - stop)
            
            overlap = label_words & all_candidate_words
            
            # If any candidate is a single meaningful word (like "python", "java"),
            for cand in candidates_lower:
                cand_clean = cand.strip()
                if len(cand_clean.split()) == 1 and len(cand_clean) > 2:
                    if cand_clean in label_words:
                        return True
            
            if len(label_words) >= 3:
                return len(overlap) >= 2
            return len(overlap) >= 1
        
        return [s for s in results if has_overlap(s.get('label', ''))]
    except Exception as e:
        print("Extractor crash:", e)
        return []
    
@app.route("/extract-skill_gap_analysis", methods=["POST"])
def extract_gap():
    try:
        data = request.get_json(silent=True) or {}
        have_text = as_text(data.get("have"))
        need_text = as_text(data.get("need"))

        def _pick_extractor(text):
            lines = text.strip().split('\n')
            return extract_candidate_phrases_from_file if len(lines) > 5 else extract_candidate_phrases

        have_candidates = _pick_extractor(have_text)(have_text)
        need_candidates = _pick_extractor(need_text)(need_text)

        have_extracted = safe_extract_skills(have_candidates)
        need_extracted = safe_extract_skills(need_candidates)

        # Deduplicate by ESCO id
        def dedup_by_id(items):
            seen = set()
            out = []
            for x in items:
                if not isinstance(x, dict):
                    continue
                sid = x.get("id")
                if not sid or sid in seen:
                    continue
                seen.add(sid)
                out.append(x)
                
            return out

        have_extracted = dedup_by_id(have_extracted)
        need_extracted = dedup_by_id(need_extracted)

        # No recognizable target skills
        if not need_extracted:
            return jsonify({
                "missing": [],
                "scores": ["No recognizable ESCO skills in 'Need'."],
                "path": [],
                "similarity_chart": [],
                "summary_chart": {
                    "have": len(have_extracted),
                    "need": len(need_extracted),
                    "missing": 0,
                    "covered": 0,
                },
            })

        have_ids = {x["id"] for x in have_extracted}
        have_labels = [x["label"] for x in have_extracted]

        # Missing = skills in need but not already in have
        missing = [s for s in need_extracted if s["id"] not in have_ids]
        missing_labels = [s["label"] for s in missing]
        covered_count = max(len(need_extracted) - len(missing), 0)

        # No missing skills
        if not missing:
            return jsonify({
                "missing": [],
                "scores": ["You already have all required ESCO skills."],
                "path": [],
                "similarity_chart": [],
                "summary_chart": {
                    "have": len(have_extracted),
                    "need": len(need_extracted),
                    "missing": 0,
                    "covered": covered_count,
                },
            })

        # Similarity scores + chart data
        scores = []
        similarity_chart = []

        if have_labels:
            for m in missing_labels:
                best_match = max(have_labels, key=lambda h: similarity(m, h))
                best_score = similarity(m, best_match)

                scores.append(f"{m} ↔ {best_match}: {best_score:.2f}")
                similarity_chart.append({
                    "label": m,
                    "best_match": best_match,
                    "score": round(best_score, 4),
                    "percent": round(best_score * 100, 1),
                })
        else:
            scores = [f"{m} ↔ (No base skills): 0.00" for m in missing_labels]
            similarity_chart = [
                {
                    "label": m,
                    "best_match": "No base skills",
                    "score": 0.0,
                    "percent": 0.0,
                }
                for m in missing_labels
            ]

        # Recommended learning path
        path = sorted(
            missing_labels,
            key=lambda m: -max((similarity(m, h) for h in have_labels), default=0.0)
        )

        return jsonify({
            "missing": [
                {
                    "label": s["label"],
                    "url": s["id"],
                    "digital": s.get("digital", False),
                    "green": s.get("green", False),
                }
                for s in missing
            ],
            "scores": scores,
            "path": path,
            "similarity_chart": sorted(
                similarity_chart,
                key=lambda x: x["percent"],
                reverse=True,
            ),
            "summary_chart": {
                "have": len(have_extracted),
                "need": len(need_extracted),
                "missing": len(missing),
                "covered": covered_count,
            },
        })

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(tb)
        return jsonify({
            "error": str(e),
            "traceback": tb
        }), 500

# Skill Filtering API (for frontend) 
@app.route("/filter-skills", methods=["POST"])
def filter_skills_api():
    data = request.get_json(silent=True) or {}

    extracted = data.get("extracted", [])  
    query = data.get("query", "")
    skill_type = data.get("skillType", "ALL")
    tags = set(data.get("tags", []))        # ["DIGITAL","GREEN"]

    filtered = filter_extracted(
        extracted,
        SKILL_INDEX,
        query=query,
        skill_type=skill_type,
        tags=tags,
    )
    return jsonify(filtered)

@app.route("/skill-types", methods=["GET"])
def skill_types():
    return jsonify(["ALL"] + SKILL_INDEX.all_types)

@app.route("/search-skills", methods=["POST"])
def search_skills():


    data = request.get_json(silent=True) or {}
    query = (data.get("query") or "").strip()
    skill_type = data.get("skillType", "ALL")
    tags = set(data.get("tags", []))
    limit = int(data.get("limit", 50))

    if not query:
        return jsonify([])

    q = query.lower()

    results = []
    for sid, meta in SKILL_INDEX.by_id.items():
        label = (meta.get("label") or "")
        alt = (meta.get("altLabels") or "")
        stype = (meta.get("skillType") or "")

        # filter by type
        if skill_type != "ALL" and stype != skill_type:
            continue

        # tags require extractor's digital/green sets.
        # We can re-use extractor's tag checks:
        is_digital = extractor._is_digital(sid)
        is_green = extractor._is_green(sid)

        if "DIGITAL" in tags and not is_digital:
            continue
        if "GREEN" in tags and not is_green:
            continue

        # search in label + altLabels
        if q not in label.lower() and q not in alt.lower():
            continue

        results.append({
            "id": sid,
            "label": label,
            "digital": is_digital,
            "green": is_green,
            "skillType": stype,
            "path": extractor._best_hierarchy_path_for_skill_label(label)  
        })

        if len(results) >= limit:
            break

    return jsonify(results)


# Helper decorator 

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            if request.path.startswith("/api/"):
                return jsonify({"error": "Login required"}), 401
            return redirect("/auth/login")
        return f(*args, **kwargs)
    return decorated


# Auth pages + JSON endpoints

@app.route("/auth/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        data  = request.get_json(silent=True) or request.form
        email = (data.get("email") or "").strip().lower()
        pwd   = (data.get("password") or "")
        name  = (data.get("display_name") or email.split("@")[0]).strip()

        if not email or not pwd:
            return jsonify({"error": "Email and password are required"}), 400
        if User.query.filter_by(email=email).first():
            return jsonify({"error": "Email already registered"}), 409

        user = User(
            email         = email,
            password_hash = generate_password_hash(pwd),
            display_name  = name[:100],
        )
        db.session.add(user)
        db.session.commit()
        # auto-login after register
        session["user_id"] = user.id
        return jsonify({"ok": True, "display_name": user.display_name})

    return render_template("register.html", host=args.host, port=args.port)


@app.route("/auth/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        data  = request.get_json(silent=True) or request.form
        email = (data.get("email") or "").strip().lower()
        pwd   = (data.get("password") or "")

        user  = User.query.filter_by(email=email).first()
        if not user or not check_password_hash(user.password_hash, pwd):
            return jsonify({"error": "Invalid email or password"}), 401

        session["user_id"] = user.id
        return jsonify({"ok": True, "display_name": user.display_name})

    return render_template("login.html", host=args.host, port=args.port)


@app.route("/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect("/")


@app.route("/auth/me", methods=["GET"])
def auth_me():
    uid = session.get("user_id")
    if not uid:
        return jsonify({"logged_in": False})
    user = User.query.get(uid)
    if not user:
        session.clear()
        return jsonify({"logged_in": False})
    return jsonify({"logged_in": True, "display_name": user.display_name, "email": user.email})


# Profile page 

@app.route("/profile")
@login_required
def profile_page():
    return render_template("profile.html", host=args.host, port=args.port)


# Saved Items API 

@app.route("/api/saved", methods=["GET"])
@login_required
def api_get_saved():
    uid   = session["user_id"]
    itype = request.args.get("type")
    q     = SavedItem.query.filter_by(user_id=uid)
    if itype:
        q = q.filter_by(item_type=itype)
    items = q.order_by(SavedItem.created_at.desc()).all()
    return jsonify([i.to_dict() for i in items])


@app.route("/api/saved/<int:item_id>", methods=["GET"])
@login_required
def api_get_saved_item(item_id):
    uid  = session["user_id"]
    item = SavedItem.query.filter_by(id=item_id, user_id=uid).first_or_404()
    return jsonify(item.to_dict(include_payload=True))


@app.route("/api/saved", methods=["POST"])
@login_required
def api_save_item():
    uid  = session["user_id"]
    data = request.get_json(silent=True) or {}

    label     = (data.get("label") or "Untitled")[:200]
    item_type = data.get("type", "skills")
    payload   = json.dumps(data.get("payload", {}))

    item = SavedItem(user_id=uid, item_type=item_type, label=label, payload=payload)
    db.session.add(item)
    db.session.commit()
    return jsonify({"id": item.id, "label": item.label})


@app.route("/api/saved/<int:item_id>", methods=["DELETE"])
@login_required
def api_delete_saved(item_id):
    uid  = session["user_id"]
    item = SavedItem.query.filter_by(id=item_id, user_id=uid).first_or_404()
    db.session.delete(item)
    db.session.commit()
    return jsonify({"ok": True})


# SGA Tracker API 

@app.route("/api/sga-tracker", methods=["GET"])
@login_required
def api_list_sga():
    uid      = session["user_id"]
    analyses = (
        SgaAnalysis.query
        .filter_by(user_id=uid)
        .order_by(SgaAnalysis.updated_at.desc())
        .all()
    )
    return jsonify([a.to_dict() for a in analyses])


@app.route("/api/sga-tracker", methods=["POST"])
@login_required
def api_create_sga():
    uid  = session["user_id"]
    data = request.get_json(silent=True) or {}

    missing_raw = data.get("missing", [])
    # ensure each skill has a `learned` flag
    missing_with_progress = [
        {**s, "learned": False} for s in missing_raw
    ]

    a = SgaAnalysis(
        user_id          = uid,
        title            = (data.get("title") or "Untitled Analysis")[:200],
        occupation_label = (data.get("occupation_label") or "")[:200],
        have_skills      = json.dumps(data.get("have", [])),
        need_skills      = json.dumps(data.get("need", [])),
        missing_skills   = json.dumps(missing_with_progress),
        total_needed     = len(missing_with_progress),
        learned_count    = 0,
    )
    db.session.add(a)
    db.session.commit()
    return jsonify({"id": a.id})


@app.route("/api/sga-tracker/<int:analysis_id>", methods=["GET"])
@login_required
def api_get_sga(analysis_id):
    uid = session["user_id"]
    a   = SgaAnalysis.query.filter_by(id=analysis_id, user_id=uid).first_or_404()
    return jsonify(a.to_dict(include_skills=True))


@app.route("/api/sga-tracker/<int:analysis_id>/toggle-skill", methods=["POST"])
@login_required
def api_toggle_learned(analysis_id):
    """Toggle one missing skill as learned / not learned."""
    uid   = session["user_id"]
    a     = SgaAnalysis.query.filter_by(id=analysis_id, user_id=uid).first_or_404()
    data  = request.get_json(silent=True) or {}
    label = data.get("label", "").strip()

    skills = json.loads(a.missing_skills or "[]")
    for s in skills:
        if s.get("label", "").strip() == label:
            s["learned"] = not s.get("learned", False)
            break
    else:
        return jsonify({"error": "Skill not found"}), 404

    a.missing_skills = json.dumps(skills)
    a.learned_count  = sum(1 for s in skills if s.get("learned"))
    a.updated_at     = datetime.utcnow()
    db.session.commit()

    return jsonify({
        "learned_count": a.learned_count,
        "total_needed":  a.total_needed,
        "progress_pct":  a.progress_pct,
    })


@app.route("/api/sga-tracker/<int:analysis_id>", methods=["DELETE"])
@login_required
def api_delete_sga(analysis_id):
    uid = session["user_id"]
    a   = SgaAnalysis.query.filter_by(id=analysis_id, user_id=uid).first_or_404()
    db.session.delete(a)
    db.session.commit()
    return jsonify({"ok": True})



# ----- Serve ----- #
if __name__ == "__main__":
    print(f"🚀 Starting ESCO Skill Extractor at http://{args.host}:{args.port}")
    serve(app, host=args.host, port=args.port, channel_timeout=12000)