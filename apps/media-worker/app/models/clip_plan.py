from __future__ import annotations

from pydantic import BaseModel, Field


class ClipPlanItem(BaseModel):
    startSeconds: float = Field(ge=0)
    endSeconds: float = Field(gt=0)
    title: str = Field(min_length=1, max_length=100)
    hook: str = Field(default="", max_length=300)
    reason: str = Field(default="", max_length=500)
    # Ranking heuristic in [0, 1] — not a prediction of virality.
    score: float = Field(ge=0, le=1)

    @property
    def duration(self) -> float:
        return self.endSeconds - self.startSeconds


class ClipPlan(BaseModel):
    clips: list[ClipPlanItem]


# JSON schema handed to the LLM for structured output (strict mode).
CLIP_PLAN_JSON_SCHEMA: dict = {
    "name": "clip_plan",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["clips"],
        "properties": {
            "clips": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["startSeconds", "endSeconds", "title", "hook", "reason", "score"],
                    "properties": {
                        "startSeconds": {"type": "number"},
                        "endSeconds": {"type": "number"},
                        "title": {"type": "string"},
                        "hook": {"type": "string"},
                        "reason": {"type": "string"},
                        "score": {"type": "number"},
                    },
                },
            }
        },
    },
}
