from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any
from urllib.parse import urlparse

from .case_store import CaseStore
from .arsenal import ArsenalNormalizer
from .executor import ExecutionResult
from .web_recon import PageRecord, SearchResult, canonical_result_url


class ResearchEvidencePipeline:
    def __init__(self, store: CaseStore | None = None):
        self.store = store or CaseStore()

    def start_web_recon(self, case_id: str, config: dict[str, Any]) -> str:
        return self.store.create_run(
            case_id,
            "visual-web-recon",
            adapter="native-web-recon",
            traffic_class="direct-observational",
            config=config,
        )

    def ingest_web_page(
        self,
        case_id: str,
        run_id: str,
        target: SearchResult,
        record: PageRecord,
        result: dict[str, Any],
    ) -> str:
        final_url = str(record.fields.get("final_url") or record.fields.get("requested_url") or target.url)
        domain = (urlparse(final_url).hostname or "").lower().removeprefix("www.")
        entity_id = self.store.upsert_entity(case_id, "domain", domain, confidence=0.8) if domain else None
        if entity_id:
            self.store.add_identifier(case_id, "domain", domain, entity_id=entity_id, confidence=0.9)
            self.store.add_identifier(
                case_id,
                "url",
                canonical_result_url(final_url) or final_url,
                entity_id=entity_id,
                confidence=0.9,
            )

        artifact_content = record.raw_bytes or json.dumps(record.fields, ensure_ascii=False, sort_keys=True).encode("utf-8")
        artifact_type = "web-response-body" if record.raw_bytes else "web-result-json"
        artifact_id = self.store.record_artifact_bytes(
            case_id,
            artifact_content,
            artifact_type,
            run_id=run_id,
            media_type=str(record.fields.get("content_type") or "application/octet-stream"),
            encoding=record.encoding,
            source_uri=final_url,
            suffix=".html" if record.raw_bytes else ".json",
            metadata={"response_headers": record.response_headers, "requested_url": target.url},
        )
        observation_value = {
            "result": result,
            "fields": record.fields,
            "response_headers": record.response_headers,
        }
        observation_id = self.store.record_observation(
            case_id,
            "web-page-analysis",
            observation_value,
            run_id=run_id,
            entity_id=entity_id,
            normalized_value=canonical_result_url(final_url) or final_url,
            source_name=target.source or "native-web-recon",
            source_uri=final_url,
            confidence=0.9 if record.fields.get("fetch_ok") else 0.25,
            artifact_id=artifact_id,
            metadata={"search_query": target.query, "search_rank": target.rank},
        )
        self.store.add_evidence(
            case_id,
            "web-recon-result",
            json.dumps(observation_value, ensure_ascii=False, sort_keys=True),
            observation_id=observation_id,
            artifact_id=artifact_id,
            source_uri=final_url,
        )

        if entity_id:
            identifier_fields = {
                "email": "emails",
                "phone": "phones",
                "social-url": "social_links",
            }
            for identifier_type, field_name in identifier_fields.items():
                for value in str(record.fields.get(field_name) or "").split(" | "):
                    if value.strip():
                        self.store.add_identifier(
                            case_id,
                            identifier_type,
                            value.strip(),
                            entity_id=entity_id,
                            confidence=0.8,
                            metadata={"source_uri": final_url, "observation_id": observation_id},
                        )
        return observation_id

    def finish_web_recon(self, run_id: str, rows: list[dict[str, Any]], *, error: str = "") -> None:
        ingest_errors = sum(1 for row in rows if row.get("evidence_ingest_error"))
        self.store.complete_run(
            run_id,
            summary={"rows": len(rows), "evidence_ingest_errors": ingest_errors},
            error=error,
        )

    def start_tool_run(
        self,
        case_id: str,
        tool_key: str,
        config: dict[str, Any],
        *,
        traffic_class: str,
    ) -> str:
        return self.store.create_run(
            case_id,
            "kali-tool-execution",
            adapter=tool_key,
            traffic_class=traffic_class,
            config=config,
        )

    def ingest_tool_result(self, case_id: str, run_id: str, result: ExecutionResult) -> str:
        stdout_bytes = result.stdout_bytes or (result.stdout or result.output).encode("utf-8", errors="surrogatepass")
        stderr_bytes = result.stderr_bytes or result.stderr.encode("utf-8", errors="surrogatepass")
        artifact_id = self.store.record_artifact_bytes(
            case_id,
            stdout_bytes,
            "tool-output",
            run_id=run_id,
            media_type="text/plain",
            encoding="utf-8",
            source_uri=result.argv[0] if result.argv else "",
            suffix=".stdout.log",
            metadata={
                "stream": "stdout",
                "argv": result.argv,
                "return_code": result.return_code,
                "timed_out": result.timed_out,
                "error": result.error,
            },
        )
        stderr_artifact_id = ""
        if stderr_bytes:
            stderr_artifact_id = self.store.record_artifact_bytes(
                case_id,
                stderr_bytes,
                "tool-stderr",
                run_id=run_id,
                media_type="text/plain",
                encoding="utf-8",
                source_uri=result.argv[0] if result.argv else "",
                suffix=".stderr.log",
                metadata={"stream": "stderr", "argv": result.argv, "return_code": result.return_code},
            )
        value = {
            "argv": result.argv,
            "started_at": result.started_at,
            "finished_at": result.finished_at,
            "return_code": result.return_code,
            "timed_out": result.timed_out,
            "duration_seconds": result.duration_seconds,
            "error": result.error,
            "stdout_artifact_id": artifact_id,
            "stderr_artifact_id": stderr_artifact_id,
            "stdout_bytes": len(stdout_bytes),
            "stderr_bytes": len(stderr_bytes),
        }
        observation_id = self.store.record_observation(
            case_id,
            "tool-execution",
            value,
            run_id=run_id,
            normalized_value=" ".join(result.argv),
            source_name=result.argv[0] if result.argv else "local-tool",
            confidence=1.0,
            artifact_id=artifact_id,
        )
        raw_evidence_id = self.store.add_evidence(
            case_id,
            "tool-output",
            result.stdout or result.output,
            observation_id=observation_id,
            artifact_id=artifact_id,
        )
        normalization = ArsenalNormalizer(self.store).ingest(
            case_id,
            run_id,
            self._tool_key_for_run(run_id, result),
            result,
            artifact_id,
            raw_evidence_id,
        )
        value["normalization"] = asdict(normalization)
        failure = result.error or ("timed out" if result.timed_out else "")
        if not failure and result.return_code not in (0, None):
            failure = f"exit code {result.return_code}"
        self.store.complete_run(run_id, summary=value, error=failure)
        return observation_id

    def _tool_key_for_run(self, run_id: str, result: ExecutionResult) -> str:
        """Resolve the registered adapter without trusting a display command name."""
        for row in self.store.list_runs_for_ids([run_id]):
            if row.get("adapter"):
                return str(row["adapter"])
        return result.argv[0] if result.argv else "local-tool"
