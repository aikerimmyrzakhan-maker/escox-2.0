
from __future__ import annotations
from datetime import datetime
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

#database models for users, saved items, and skill-gap analyses
class User(db.Model):
    __tablename__ = "users"

    id            = db.Column(db.Integer, primary_key=True)
    email         = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    display_name  = db.Column(db.String(100))
    created_at    = db.Column(db.DateTime, default=datetime.utcnow)

    saved_items   = db.relationship("SavedItem",   back_populates="user", cascade="all,delete-orphan")
    sga_analyses  = db.relationship("SgaAnalysis", back_populates="user", cascade="all,delete-orphan")

    def to_dict(self):
        return {
            "id":           self.id,
            "email":        self.email,
            "display_name": self.display_name,
            "created_at":   self.created_at.isoformat(),
        }


class SavedItem(db.Model):
    __tablename__ = "saved_items"

    id         = db.Column(db.Integer, primary_key=True)
    user_id    = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    item_type  = db.Column(db.String(20), nullable=False)    # 'skills'|'occupation'|'sga'
    label      = db.Column(db.String(200), nullable=False)   # user-given name
    payload    = db.Column(db.Text, nullable=False)          # JSON blob
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    user       = db.relationship("User", back_populates="saved_items")

    def to_dict(self, include_payload=False):
        d = {
            "id":         self.id,
            "type":       self.item_type,
            "label":      self.label,
            "created_at": self.created_at.isoformat(),
        }
        if include_payload:
            import json
            d["payload"] = json.loads(self.payload or "{}")
        return d


class SgaAnalysis(db.Model):
    """
    A named, tracked skill-gap analysis.
    missing_skills: JSON list of {label, url, digital, green, learned: bool}
    """
    __tablename__ = "sga_analyses"

    id               = db.Column(db.Integer, primary_key=True)
    user_id          = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    title            = db.Column(db.String(200), nullable=False)
    occupation_label = db.Column(db.String(200), default="")
    have_skills      = db.Column(db.Text, default="[]")   # JSON list of labels
    need_skills      = db.Column(db.Text, default="[]")   # JSON list of labels
    missing_skills   = db.Column(db.Text, default="[]")   # JSON [{label,url,digital,green,learned}]
    total_needed     = db.Column(db.Integer, default=0)
    learned_count    = db.Column(db.Integer, default=0)
    created_at       = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at       = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user             = db.relationship("User", back_populates="sga_analyses")

    @property
    def progress_pct(self) -> int:
        if not self.total_needed:
            return 0
        return round(self.learned_count / self.total_needed * 100)

    def to_dict(self, include_skills=False):
        import json
        d = {
            "id":               self.id,
            "title":            self.title,
            "occupation_label": self.occupation_label,
            "total_needed":     self.total_needed,
            "learned_count":    self.learned_count,
            "progress_pct":     self.progress_pct,
            "created_at":       self.created_at.isoformat(),
            "updated_at":       self.updated_at.isoformat(),
        }
        if include_skills:
            d["have_skills"]    = json.loads(self.have_skills    or "[]")
            d["need_skills"]    = json.loads(self.need_skills    or "[]")
            d["missing_skills"] = json.loads(self.missing_skills or "[]")
        return d
