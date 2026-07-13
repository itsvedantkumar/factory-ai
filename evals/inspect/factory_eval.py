"""Inspect tasks and dependency-free validation for Factory AI evaluation data."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATASETS = {
    "routing": ROOT / "datasets" / "routing.jsonl",
    "tool_policy": ROOT / "datasets" / "tool-policy.jsonl",
    "compaction": ROOT / "datasets" / "compaction.jsonl",
}


def validate_datasets() -> int:
    """Validate the shared Promptfoo/Inspect JSONL contract."""
    seen_ids: set[str] = set()
    count = 0
    for suite, path in DATASETS.items():
        with path.open(encoding="utf-8") as source:
            for line_number, line in enumerate(source, 1):
                record = json.loads(line)
                case_id = record["metadata"]["case_id"]
                assertions = record["assert"]
                if record["metadata"]["suite"].replace("-", "_") != suite:
                    raise ValueError(f"{path}:{line_number}: suite does not match file")
                if case_id in seen_ids:
                    raise ValueError(f"{path}:{line_number}: duplicate case_id {case_id}")
                if set(record["vars"]) != {"instruction", "input"}:
                    raise ValueError(f"{path}:{line_number}: unexpected vars")
                if len(assertions) != 1 or assertions[0].get("type") != "equals":
                    raise ValueError(f"{path}:{line_number}: requires one equals assertion")
                if not all(isinstance(record["vars"][key], str) and record["vars"][key] for key in ("instruction", "input")):
                    raise ValueError(f"{path}:{line_number}: vars must be non-empty strings")
                seen_ids.add(case_id)
                count += 1
    print(f"validated {count} evaluation cases across {len(DATASETS)} datasets")
    return 0


if __name__ == "__main__" and "--validate" in sys.argv:
    raise SystemExit(validate_datasets())


from inspect_ai import Task, task  # noqa: E402
from inspect_ai.dataset import Sample, json_dataset  # noqa: E402
from inspect_ai.scorer import match  # noqa: E402
from inspect_ai.solver import generate, system_message  # noqa: E402


SYSTEM_MESSAGE = """You are a deterministic policy classifier for Factory AI.
Follow the supplied policy exactly. Return only the requested lowercase label.
Do not explain your answer."""


def record_to_sample(record: dict) -> Sample:
    """Adapt the shared Promptfoo record to an Inspect sample."""
    variables = record["vars"]
    target = record["assert"][0]["value"]
    return Sample(
        id=record["metadata"]["case_id"],
        input=f"Policy:\n{variables['instruction']}\n\nCase:\n{variables['input']}",
        target=target,
        metadata={"suite": record["metadata"]["suite"], "description": record["description"]},
    )


def factory_task(dataset_name: str) -> Task:
    return Task(
        dataset=json_dataset(str(DATASETS[dataset_name]), record_to_sample),
        solver=[system_message(SYSTEM_MESSAGE), generate()],
        scorer=match(location="exact"),
    )


@task
def routing() -> Task:
    return factory_task("routing")


@task
def tool_policy() -> Task:
    return factory_task("tool_policy")


@task
def compaction() -> Task:
    return factory_task("compaction")
