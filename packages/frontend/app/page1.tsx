"use client";

import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

type LogEntry = {
  timestamp?: string;
  service?: string;
  level?: string;
  trace_id?: string;
  message?: string;
  [key: string]: unknown;
};

type Hypothesis = {
  cause?: string;
  service?: string;

  score?: number;
  investigation_score?: number;
  confidence?: number;
  confidence_label?: string;

  ranking?: number;
  ranking_label?: string;

  investigation_role?: string;
  investigation_status?: string;

  reason?: string;
  why_suspected?: string;
  explanation?: string;

  evidence?: unknown[];
  supporting_evidence?: unknown[];

  next_checks?: string[];
  alternative_explanations?: string[];

  score_breakdown?: Record<string, unknown>;

  [key: string]: unknown;
};

type TimelineEvent = LogEntry & {
  sequence?: number;
  event_type?: string;
  role?: string;
  description?: string;
};

type Timeline = {
  story?: string;
  event_count?: number;
  failure_count?: number;
  first_failure_timestamp?: string | null;
  events: TimelineEvent[];
  relationships?: {
    from_sequence?: number;
    to_sequence?: number;
    relationship?: string;
    causation_confirmed?: boolean;
    [key: string]: unknown;
  }[];
};

type Investigation = {
  incident_id: string;
  title: string;
  severity: string;
  logs: LogEntry[];
  investigation: unknown;
  timeline?: Timeline;
  created_at?: string;
  blockchain?: BlockchainResult;
};

type StoredIncident = Investigation;
type BlockchainResult = {
  incident_id: string;
  registered?: boolean;
  verified?: boolean;
  message?: string;

  transaction_hash?: string;
  block_number?: number;
  gas_used?: number;

  log_hash?: string;
  report_hash?: string;

  current_log_hash?: string;
  current_report_hash?: string;

  stored_log_hash?: string;
  stored_report_hash?: string;

  registered_at?: number;
  registered_by?: string;
  contract_address?: string;
  network?: string;
};

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

const STORAGE_KEY = "tracemind-investigations-v1";

const SAMPLE_LOGS: LogEntry[] = [
  {
    timestamp: "2026-10-27T10:00:00Z",
    service: "api-gateway",
    level: "INFO",
    trace_id: "trace-101",
    message: "Incoming POST /checkout",
  },
  {
    timestamp: "2026-10-27T10:00:01Z",
    service: "order-service",
    level: "INFO",
    trace_id: "trace-101",
    message: "Order checkout started",
  },
  {
    timestamp: "2026-10-27T10:00:02Z",
    service: "payment-service",
    level: "ERROR",
    trace_id: "trace-101",
    message: "Payment request timed out while waiting for database",
  },
  {
    timestamp: "2026-10-27T10:00:03Z",
    service: "order-service",
    level: "ERROR",
    trace_id: "trace-101",
    message: "Payment confirmation was not received",
  },
  {
    timestamp: "2026-10-27T10:00:04Z",
    service: "api-gateway",
    level: "ERROR",
    trace_id: "trace-101",
    message: "Returning HTTP 503 Service Unavailable",
  },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function getLogArray(value: unknown): LogEntry[] {
  return Array.isArray(value)
    ? value.filter(isObject) as LogEntry[]
    : [];
}

function formatDate(value?: string): string {
  if (!value) return "Unknown time";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function getSeverityClass(severity?: string): string {
  const value = (severity ?? "medium").toLowerCase();

  if (value.includes("critical")) return "critical";
  if (value.includes("high")) return "high";
  if (value.includes("low")) return "low";

  return "medium";
}

function getLevelClass(level?: string): string {
  const value = (level ?? "info").toLowerCase();

  if (value.includes("error") || value.includes("fatal")) {
    return "error";
  }

  if (value.includes("warn")) return "warning";

  if (value.includes("debug")) return "debug";

  return "info";
}

function getHypotheses(result: unknown): Hypothesis[] {
  if (!isObject(result)) return [];

  const possibleKeys = [
    "hypotheses",
    "root_causes",
    "possible_causes",
    "findings",
  ];

  for (const key of possibleKeys) {
    const value = result[key];

    if (Array.isArray(value)) {
      return value.filter(isObject) as Hypothesis[];
    }
  }

  return [];
}

function getSummary(result: unknown): string {
  if (typeof result === "string") return result;

  if (!isObject(result)) {
    return "Investigation results are available below.";
  }

  const possibleKeys = [
    "summary",
    "analysis",
    "conclusion",
    "root_cause",
    "description",
  ];

  for (const key of possibleKeys) {
    const value = result[key];

    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "TraceMind has processed the logs. Review the timeline and evidence to understand the possible cause.";
}

function getTimeline(
  incident: Investigation
): TimelineEvent[] {
  if (incident.timeline?.events?.length) {
    return incident.timeline.events;
  }

  return [...incident.logs].sort((a, b) => {
    const first = new Date(a.timestamp ?? "").getTime();
    const second = new Date(b.timestamp ?? "").getTime();

    return (
      (Number.isNaN(first) ? 0 : first) -
      (Number.isNaN(second) ? 0 : second)
    );
  });
}

function normalizeIncident(data: unknown): Investigation | null {
  if (!isObject(data)) return null;

  const logs = getLogArray(data.logs);

  let timeline: Timeline | undefined;

  if (isObject(data.timeline)) {
    timeline = {
      story: getString(data.timeline.story),
      event_count:
        typeof data.timeline.event_count === "number"
          ? data.timeline.event_count
          : undefined,
      failure_count:
        typeof data.timeline.failure_count === "number"
          ? data.timeline.failure_count
          : undefined,
      first_failure_timestamp:
        typeof data.timeline.first_failure_timestamp === "string"
          ? data.timeline.first_failure_timestamp
          : null,
      events: getLogArray(data.timeline.events) as TimelineEvent[],
      relationships: Array.isArray(data.timeline.relationships)
        ? data.timeline.relationships.filter(isObject)
        : [],
    };
  }

  return {
    incident_id: getString(data.incident_id, "INC-UNKNOWN"),
    title: getString(data.title, "Incident investigation"),
    severity: getString(data.severity, "Medium"),
    logs,
    investigation: data.investigation ?? {},
    timeline,
    created_at: getString(data.created_at, new Date().toISOString()),
    blockchain: isObject(data.blockchain)
      ? (data.blockchain as BlockchainResult)
      : undefined,
  };
}

function getEvidenceText(entry: unknown): string {
  if (typeof entry === "string") return entry;

  if (!isObject(entry)) return String(entry ?? "");

  const service = getString(entry.service, "Unknown service");
  const message = getString(entry.message, "");
  const timestamp = getString(entry.timestamp, "");

  return [service, message, timestamp].filter(Boolean).join(" · ");
}

function findEvidenceTimelineIndex(
  entry: unknown,
  timeline: TimelineEvent[]
): number {
  if (!isObject(entry)) return -1;

  const evidenceTimestamp = getString(entry.timestamp);
  const evidenceService = getString(entry.service).toLowerCase().trim();
  const evidenceMessage = getString(entry.message).toLowerCase().trim();
  const evidenceTraceId = getString(entry.trace_id).toLowerCase().trim();

  let bestIndex = -1;
  let bestScore = 0;

  timeline.forEach((event, index) => {
    let score = 0;

    const eventTimestamp = getString(event.timestamp);
    const eventService = getString(event.service).toLowerCase().trim();
    const eventMessage = (
      getString(event.message) || getString(event.description)
    ).toLowerCase().trim();
    const eventTraceId = getString(event.trace_id).toLowerCase().trim();

    if (
      evidenceTimestamp &&
      eventTimestamp &&
      evidenceTimestamp === eventTimestamp
    ) {
      score += 5;
    }

    if (evidenceService && evidenceService === eventService) {
      score += 3;
    }

    if (evidenceMessage && evidenceMessage === eventMessage) {
      score += 4;
    }

    if (evidenceTraceId && evidenceTraceId === eventTraceId) {
      score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  // Require a reasonably strong match to avoid highlighting the wrong event.
  return bestScore >= 5 ? bestIndex : -1;
}

export default function HomePage() {
  const [incidents, setIncidents] = useState<StoredIncident[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTimelineIndex, setSelectedTimelineIndex] =
  useState<number | null>(null);

  const [activePage, setActivePage] = useState<"overview" | "investigations">(
    "overview"
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  const [loading, setLoading] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [blockchainResult, setBlockchainResult] =
    useState<BlockchainResult | null>(null);

  const [blockchainLoading, setBlockchainLoading] =
    useState<"register" | "verify" | null>(null);

  const [blockchainError, setBlockchainError] = useState("");

  const [apiStatus, setApiStatus] = useState<
    "checking" | "online" | "offline"
  >("checking");

  const [showUpload, setShowUpload] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);

      if (saved) {
        const parsed: unknown = JSON.parse(saved);

        if (Array.isArray(parsed)) {
          const validIncidents = parsed
            .map(normalizeIncident)
            .filter(
              (item): item is Investigation => item !== null
            );

          setIncidents(validIncidents);

          if (validIncidents.length > 0) {
            setSelectedId(validIncidents[0].incident_id);
          }
        }
      }
    } catch (err) {
      console.error("Could not load saved investigations:", err);
    } finally {
      setHistoryLoaded(true);
    }

    fetch(`${API_BASE}/api/incidents/demo`)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Backend is unavailable");
        }

        setApiStatus("online");
      })
      .catch(() => {
        setApiStatus("offline");
      });
  }, []);

  useEffect(() => {
    if (!historyLoaded) return;

    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(incidents)
      );
    } catch (err) {
      console.error("Could not save investigation history:", err);
    }
  }, [incidents, historyLoaded]);

  const selectedIncident = useMemo(() => {
    return (
      incidents.find((item) => item.incident_id === selectedId) ??
      incidents[0] ??
      null
    );
  }, [incidents, selectedId]);

  const registeredIncidents = useMemo(() => {
    return incidents.filter(
      (incident) =>
        incident.blockchain?.registered === true &&
        Boolean(incident.blockchain?.transaction_hash)
    );
  }, [incidents]);

  useEffect(() => {
    setBlockchainResult(selectedIncident?.blockchain ?? null);
    setBlockchainError("");
  }, [selectedIncident?.incident_id]);

  const filteredIncidents = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return incidents.filter((incident) => {
      const matchesQuery =
        !query ||
        incident.incident_id.toLowerCase().includes(query) ||
        incident.title.toLowerCase().includes(query) ||
        incident.severity.toLowerCase().includes(query);

      const matchesSeverity =
        severityFilter === "all" ||
        incident.severity.toLowerCase() === severityFilter;

      return matchesQuery && matchesSeverity;
    });
  }, [incidents, searchQuery, severityFilter]);

  const selectedInvestigation = selectedIncident?.investigation;
  const hypotheses = selectedIncident
    ? getHypotheses(selectedInvestigation)
    : [];

  const timeline = selectedIncident
    ? getTimeline(selectedIncident)
    : [];

  const handleBlockchainAction = async (
    action: "register" | "verify"
  ) => {
    if (!selectedIncident) return;

    if (!isObject(selectedIncident.investigation)) {
      setBlockchainError("Investigation report is not available.");
      return;
    }

    setBlockchainLoading(action);
    setBlockchainError("");
    setNotice("");
    setBlockchainResult(null);

    try {
      const response = await fetch(
        `${API_BASE}/api/evidence/${action}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            incident_id: selectedIncident.incident_id,
            logs: selectedIncident.logs,
            report: selectedIncident.investigation,
          }),
        }
      );

      const data: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        const detail =
          isObject(data) && typeof data.detail === "string"
            ? data.detail
            : `Blockchain API returned HTTP ${response.status}`;

        throw new Error(detail);
      }

      if (!isObject(data)) {
        throw new Error("Invalid blockchain API response.");
      }

      const result = data as BlockchainResult;
      setBlockchainResult(result);

      setIncidents((previous) =>
        previous.map((incident) =>
          incident.incident_id === selectedIncident.incident_id
            ? {
                ...incident,
                blockchain: {
                  ...incident.blockchain,
                  ...result,
                },
              }
            : incident
        )
      );

      if (action === "register") {
        setNotice("Evidence successfully registered on MST Testnet.");
      }
    } catch (err) {
      setBlockchainError(
        err instanceof Error
          ? err.message
          : "Blockchain operation failed."
      );
    } finally {
      setBlockchainLoading(null);
    }
  };

  useEffect(() => {
    if (selectedTimelineIndex === null) return;

    const element = document.getElementById(
      `tm-timeline-event-${selectedTimelineIndex}`
    );

    element?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [selectedTimelineIndex]);

  const handleEvidenceClick = (entry: unknown) => {
    const matchingIndex = findEvidenceTimelineIndex(entry, timeline);

    if (matchingIndex === -1) {
      setNotice(
        "Could not find an exact matching event in the timeline."
      );
      return;
    }

    setNotice("");
    setSelectedTimelineIndex(matchingIndex);
  };

  const summary = selectedIncident
    ? getSummary(selectedInvestigation)
    : "Upload log files or load the demo incident to begin your investigation.";

  const uniqueServices = new Set(
    selectedIncident?.logs
      .map((log) => getString(log.service))
      .filter(Boolean) ?? []
  );

  const errorCount =
    selectedIncident?.logs.filter((log) => {
      const level = getString(log.level).toLowerCase();
      return level.includes("error") || level.includes("fatal");
    }).length ?? 0;

  const saveIncident = useCallback((incident: Investigation) => {
    setIncidents((previous) => {
      const withoutDuplicate = previous.filter(
        (item) => item.incident_id !== incident.incident_id
      );

      return [incident, ...withoutDuplicate];
    });

    setSelectedId(incident.incident_id);
    setActivePage("overview");
    setShowUpload(false);
    setSelectedFile(null);
    setError("");
    setNotice("Investigation completed and saved in this browser.");
    setSelectedTimelineIndex(null);
  }, []);

  const loadDemo = async () => {
    setLoadingDemo(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`${API_BASE}/api/incidents/demo`);

      if (!response.ok) {
        throw new Error(`Backend returned HTTP ${response.status}`);
      }

      const data: unknown = await response.json();
      const incident = normalizeIncident(data);

      if (!incident) {
        throw new Error("The demo endpoint returned an invalid response.");
      }

      saveIncident(incident);
      setApiStatus("online");
    } catch (err) {
      setApiStatus("offline");
      setError(
        err instanceof Error
          ? `${err.message}. Make sure the FastAPI backend is running on ${API_BASE}.`
          : "Could not load the demo incident."
      );
    } finally {
      setLoadingDemo(false);
    }
  };

  const handleFileSelection = (file?: File | null) => {
    setError("");
    setNotice("");

    if (!file) {
      setSelectedFile(null);
      return;
    }

    if (!file.name.toLowerCase().endsWith(".json")) {
      setSelectedFile(null);
      setError("Please select a JSON log file.");
      return;
    }

    setSelectedFile(file);
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFileSelection(event.target.files?.[0] ?? null);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    handleFileSelection(event.dataTransfer.files?.[0] ?? null);
  };

  const runInvestigation = async () => {
    if (!selectedFile) {
      setError("Choose a JSON log file before starting the investigation.");
      return;
    }

    setLoading(true);
    setError("");
    setNotice("");

    try {
      const fileText = await selectedFile.text();

      let parsed: unknown;

      try {
        parsed = JSON.parse(fileText);
      } catch {
        throw new Error("The selected file contains invalid JSON.");
      }

      if (!Array.isArray(parsed)) {
        throw new Error(
          "The JSON file must contain an array of log events."
        );
      }

      if (parsed.length === 0) {
        throw new Error("The log file does not contain any events.");
      }

      const formData = new FormData();
      formData.append("file", selectedFile);

      const response = await fetch(`${API_BASE}/api/investigate`, {
        method: "POST",
        body: formData,
      });

      const data: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        const detail =
          isObject(data) && typeof data.detail === "string"
            ? data.detail
            : `Backend returned HTTP ${response.status}`;

        throw new Error(detail);
      }

      const incident = normalizeIncident(data);

      if (!incident) {
        throw new Error("The backend returned an invalid investigation.");
      }

      if (!incident.logs.length) {
        incident.logs = parsed.filter(isObject) as LogEntry[];
      }

      incident.title =
        selectedFile.name.replace(/\.json$/i, "").replace(/[_-]/g, " ") ||
        incident.title;

      incident.created_at = new Date().toISOString();

      saveIncident(incident);
      setApiStatus("online");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong while investigating the logs."
      );
    } finally {
      setLoading(false);
    }
  };

  const openIncident = (incident: Investigation) => {
    setSelectedId(incident.incident_id);
    setActivePage("overview");
    setError("");
    setNotice("");
    setSelectedTimelineIndex(null);
  };

  const deleteHistory = () => {
    const confirmed = window.confirm(
      "Clear all investigations saved in this browser?"
    );

    if (!confirmed) return;

    setIncidents([]);
    setSelectedId(null);
    setNotice("Browser investigation history cleared.");
    setError("");
  };

  const renderEvidence = (entry: unknown, index: number) => {
    if (typeof entry === "string") {
      return <li key={index}>{entry}</li>;
    }

    if (!isObject(entry)) {
      return <li key={index}>{String(entry ?? "")}</li>;
    }

    return (
      <li key={index}>
        <div className="tm-evidence-entry">
          <div className="tm-evidence-header">
            <strong>
              {getString(entry.service, "Unknown service")}
            </strong>

            {typeof entry.level === "string" && (
              <span className={`tm-level ${getLevelClass(entry.level)}`}>
                {entry.level}
              </span>
            )}
          </div>

          {typeof entry.message === "string" && (
            <p>{entry.message}</p>
          )}

          <small>
            {getString(entry.timestamp)}
            {typeof entry.trace_id === "string"
              ? ` · Trace: ${entry.trace_id}`
              : ""}
          </small>

          <button
            type="button"
            className="tm-evidence-link"
            onClick={() => handleEvidenceClick(entry)}
          >
            Find in timeline →
          </button>
        </div>
      </li>
    );
  };

  return (
    <main className="tm-app">
      <aside className="tm-sidebar">
        <div className="tm-brand">
          <div className="tm-brand-icon">
            <svg
              width="25"
              height="25"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 6.5h6l2 3h8M4 17.5h6l2-3h8"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="4" cy="6.5" r="2" fill="currentColor" />
              <circle cx="20" cy="9.5" r="2" fill="currentColor" />
              <circle cx="4" cy="17.5" r="2" fill="currentColor" />
              <circle cx="20" cy="14.5" r="2" fill="currentColor" />
            </svg>
          </div>

          <div>
            <strong>TraceMind</strong>
            <span>Incident intelligence</span>
          </div>
        </div>

        <div className="tm-workspace-label">WORKSPACE</div>

        <nav className="tm-navigation">
          <button
            className={`tm-nav-item ${
              activePage === "overview" ? "active" : ""
            }`}
            onClick={() => setActivePage("overview")}
          >
            <span className="tm-nav-icon">◫</span>
            Overview
          </button>

          <button
            className={`tm-nav-item ${
              activePage === "investigations" ? "active" : ""
            }`}
            onClick={() => setActivePage("investigations")}
          >
            <span className="tm-nav-icon">▤</span>
            All investigations
            <span className="tm-nav-count">{incidents.length}</span>
          </button>
        </nav>

        <div className="tm-sidebar-spacer" />

        <div className="tm-sidebar-card">
          <div className="tm-sidebar-card-icon">✳</div>
          <strong>Evidence-first analysis</strong>
          <p>
            Connect events, investigate causes, and keep the evidence visible.
          </p>
        </div>

        <div className="tm-sidebar-footer">
          <span className={`tm-status-dot ${apiStatus}`} />
          <span>
            Backend{" "}
            {apiStatus === "checking"
              ? "checking"
              : apiStatus === "online"
                ? "connected"
                : "offline"}
          </span>
        </div>
      </aside>

      <section className="tm-main">
        <header className="tm-topbar">
          <div className="tm-breadcrumb">
            <span>TraceMind</span>
            <span className="tm-breadcrumb-separator">/</span>
            <strong>
              {activePage === "overview" ? "Overview" : "Investigations"}
            </strong>
          </div>

          <div className="tm-topbar-actions">
            <span className={`tm-connection ${apiStatus}`}>
              <span className={`tm-status-dot ${apiStatus}`} />
              {apiStatus === "online"
                ? "API connected"
                : apiStatus === "offline"
                  ? "API unavailable"
                  : "Checking API"}
            </span>

            <button
              className="tm-button tm-button-primary"
              onClick={() => {
                setShowUpload(true);
                setError("");
                setNotice("");
              }}
            >
              <span>＋</span> New investigation
            </button>
          </div>
        </header>

        <div className="tm-content">
          {activePage === "overview" ? (
            <>
              <section className="tm-page-heading">
                <div>
                  <div className="tm-eyebrow">INCIDENT INTELLIGENCE</div>
                  <h1>Incident overview</h1>
                  <p>
                    Understand what happened, trace possible causes, and
                    inspect the evidence behind every finding.
                  </p>
                </div>

                <button
                  className="tm-button tm-button-secondary"
                  onClick={loadDemo}
                  disabled={loadingDemo}
                >
                  {loadingDemo ? "Loading..." : "↻ Load demo incident"}
                </button>
              </section>

              {error && (
                <div className="tm-alert tm-alert-error" role="alert">
                  <span>!</span>
                  <div>
                    <strong>Something went wrong</strong>
                    <p>{error}</p>
                  </div>
                  <button
                    className="tm-alert-close"
                    onClick={() => setError("")}
                    aria-label="Dismiss error"
                  >
                    ×
                  </button>
                </div>
              )}

              {notice && (
                <div className="tm-alert tm-alert-success" role="status">
                  <span>✓</span>
                  <p>{notice}</p>
                  <button
                    className="tm-alert-close"
                    onClick={() => setNotice("")}
                    aria-label="Dismiss notice"
                  >
                    ×
                  </button>
                </div>
              )}

              <section className="tm-metrics">
                <article className="tm-metric-card">
                  <div className="tm-metric-top">
                    <span className="tm-metric-label">
                      Saved investigations
                    </span>
                    <span className="tm-metric-icon green">▤</span>
                  </div>
                  <div className="tm-metric-value">{incidents.length}</div>
                  <div className="tm-metric-caption">
                    Stored in this browser
                  </div>
                </article>

                <article className="tm-metric-card">
                  <div className="tm-metric-top">
                    <span className="tm-metric-label">Log events</span>
                    <span className="tm-metric-icon blue">≋</span>
                  </div>
                  <div className="tm-metric-value">
                    {selectedIncident?.logs.length ?? 0}
                  </div>
                  <div className="tm-metric-caption">
                    In the selected incident
                  </div>
                </article>

                <article className="tm-metric-card">
                  <div className="tm-metric-top">
                    <span className="tm-metric-label">Affected services</span>
                    <span className="tm-metric-icon purple">⌘</span>
                  </div>
                  <div className="tm-metric-value">{uniqueServices.size}</div>
                  <div className="tm-metric-caption">
                    Distinct services identified
                  </div>
                </article>

                <article className="tm-metric-card">
                  <div className="tm-metric-top">
                    <span className="tm-metric-label">Error events</span>
                    <span className="tm-metric-icon red">⚠</span>
                  </div>
                  <div className="tm-metric-value">{errorCount}</div>
                  <div className="tm-metric-caption">
                    Error or fatal log entries
                  </div>
                </article>
              </section>

              {showUpload && (
                <section className="tm-panel tm-upload-panel">
                  <div className="tm-panel-heading">
                    <div>
                      <div className="tm-eyebrow">START HERE</div>
                      <h2>Run a new investigation</h2>
                      <p>
                        Upload a JSON file containing an array of log events.
                      </p>
                    </div>

                    <button
                      className="tm-icon-button"
                      onClick={() => {
                        setShowUpload(false);
                        setSelectedFile(null);
                        setError("");
                      }}
                      aria-label="Close upload panel"
                    >
                      ×
                    </button>
                  </div>

                  <div
                    className={`tm-dropzone ${dragging ? "dragging" : ""} ${
                      selectedFile ? "has-file" : ""
                    }`}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  >
                    <div className="tm-upload-icon">
                      {selectedFile ? "✓" : "↑"}
                    </div>

                    {selectedFile ? (
                      <>
                        <strong>{selectedFile.name}</strong>
                        <p>
                          {(selectedFile.size / 1024).toFixed(1)} KB · Ready
                          to investigate
                        </p>
                      </>
                    ) : (
                      <>
                        <strong>Drop your log file here</strong>
                        <p>JSON format · An array of log events</p>
                      </>
                    )}

                    <label className="tm-button tm-button-secondary tm-file-button">
                      {selectedFile ? "Choose another file" : "Browse files"}
                      <input
                        type="file"
                        accept=".json,application/json"
                        onChange={handleInputChange}
                      />
                    </label>
                  </div>

                  <div className="tm-upload-footer">
                    <p>
                      <span>ⓘ</span> The file is sent to your local FastAPI
                      backend for analysis.
                    </p>

                    <button
                      className="tm-button tm-button-primary"
                      onClick={runInvestigation}
                      disabled={loading || !selectedFile}
                    >
                      {loading ? (
                        <>
                          <span className="tm-spinner" />
                          Investigating...
                        </>
                      ) : (
                        <>Run investigation →</>
                      )}
                    </button>
                  </div>
                </section>
              )}

              <section className="tm-panel tm-selected-incident">
                <div className="tm-panel-heading">
                  <div>
                    <div className="tm-eyebrow">INVESTIGATION REPORT</div>
                    <h2>
                      {selectedIncident
                        ? selectedIncident.title
                        : "No incident selected"}
                    </h2>
                    <p>
                      {selectedIncident
                        ? `${selectedIncident.incident_id} · ${selectedIncident.logs.length} log events`
                        : "Load the demo incident or upload a JSON log file to get started."}
                    </p>
                  </div>

                  {selectedIncident && (
                    <span
                      className={`tm-severity ${getSeverityClass(
                        selectedIncident.severity
                      )}`}
                    >
                      {selectedIncident.severity}
                    </span>
                  )}
                </div>

                {selectedIncident ? (
                  <div className="tm-summary">
                    <div className="tm-summary-icon">✳</div>
                    <div>
                      <div className="tm-summary-label">
                        INVESTIGATION SUMMARY
                      </div>
                      <p>{summary}</p>
                      <small>
                        AI-generated findings should be checked against the
                        underlying log evidence.
                      </small>
                    </div>
                  </div>
                ) : (
                  <div className="tm-empty-state">
                    <div className="tm-empty-icon">⌁</div>
                    <h3>Your investigation workspace is ready</h3>
                    <p>
                      Load a sample incident to explore the dashboard, or
                      upload your own JSON logs to investigate a failure.
                    </p>
                    <div className="tm-empty-actions">
                      <button
                        className="tm-button tm-button-primary"
                        onClick={loadDemo}
                        disabled={loadingDemo}
                      >
                        {loadingDemo ? "Loading..." : "Load demo incident"}
                      </button>
                      <button
                        className="tm-button tm-button-secondary"
                        onClick={() => setShowUpload(true)}
                      >
                        Upload logs
                      </button>
                    </div>
                  </div>
                )}
              </section>

              {selectedIncident && (
                <section className="tm-panel tm-blockchain-panel">
                  <div className="tm-panel-heading">
                    <div>
                      <div className="tm-eyebrow">MST BLOCKCHAIN</div>
                      <h2>Evidence integrity</h2>
                      <p>
                        Register investigation evidence and verify that it
                        has not changed since registration.
                      </p>
                    </div>

                    <span
                      className={`tm-blockchain-status ${
                        blockchainResult?.verified === true
                          ? "verified"
                          : blockchainResult?.verified === false &&
                              blockchainResult.registered
                            ? "tampered"
                            : blockchainResult?.registered
                              ? "registered"
                              : ""
                      }`}
                    >
                      {blockchainResult?.verified === true
                        ? "Verified"
                        : blockchainResult?.verified === false &&
                            blockchainResult.registered
                          ? "Mismatch detected"
                          : blockchainResult?.registered
                            ? "Registered"
                            : "Not checked"}
                    </span>
                  </div>

                  <div className="tm-blockchain-info">
                    <div>
                      <span>Incident ID</span>
                      <strong>{selectedIncident.incident_id}</strong>
                    </div>

                    <div>
                      <span>Network</span>
                      <strong>MST Testnet</strong>
                    </div>

                    <div>
                      <span>Smart contract</span>
                      <strong className="tm-blockchain-address">
                        0x39cC2195...604Bdd9
                      </strong>
                    </div>
                  </div>

                  <div className="tm-blockchain-actions">
                    <button
                      className="tm-button tm-button-primary"
                      onClick={() => handleBlockchainAction("register")}
                      disabled={blockchainLoading !== null}
                    >
                      {blockchainLoading === "register"
                        ? "Registering..."
                        : "Register on Blockchain"}
                    </button>

                    <button
                      className="tm-button tm-button-secondary"
                      onClick={() => handleBlockchainAction("verify")}
                      disabled={blockchainLoading !== null}
                    >
                      {blockchainLoading === "verify"
                        ? "Verifying..."
                        : "Verify Evidence"}
                    </button>
                  </div>

                  {blockchainError && (
                    <div className="tm-blockchain-error">
                      {blockchainError}
                    </div>
                  )}

                  {blockchainResult && (
                    <div className="tm-blockchain-result">
                      <strong>{blockchainResult.message}</strong>

                      {blockchainResult.transaction_hash && (
                        <div>
                          <span>Transaction hash</span>
                          <code>{blockchainResult.transaction_hash}</code>
                        </div>
                      )}

                      {blockchainResult.block_number !== undefined && (
                        <div>
                          <span>Block number</span>
                          <strong>{blockchainResult.block_number}</strong>
                        </div>
                      )}

                      {blockchainResult.registered_by && (
                        <div>
                          <span>Registered by</span>
                          <code>{blockchainResult.registered_by}</code>
                        </div>
                      )}

                      {(blockchainResult.log_hash ||
                        blockchainResult.current_log_hash) && (
                        <div>
                          <span>Current log hash</span>
                          <code>
                            {blockchainResult.log_hash ??
                              blockchainResult.current_log_hash}
                          </code>
                        </div>
                      )}

                      {(blockchainResult.report_hash ||
                        blockchainResult.current_report_hash) && (
                        <div>
                          <span>Current report hash</span>
                          <code>
                            {blockchainResult.report_hash ??
                              blockchainResult.current_report_hash}
                          </code>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}

                            <section className="tm-panel tm-history-panel">
                <div className="tm-panel-heading">
                  <div>
                    <div className="tm-eyebrow">MST BLOCKCHAIN</div>
                    <h2>Blockchain Evidence Explorer</h2>
                    <p>
                      View investigation evidence registered on MST Testnet.
                    </p>
                  </div>

                  <span className="tm-small-count">
                    {registeredIncidents.length} registered
                  </span>
                </div>

                {registeredIncidents.length > 0 ? (
                  <div className="tm-table-wrap">
                    <table className="tm-table">
                      <thead>
                        <tr>
                          <th>Incident</th>
                          <th>Transaction hash</th>
                          <th>Block number</th>
                          <th>Status</th>
                          <th />
                        </tr>
                      </thead>

                      <tbody>
                        {registeredIncidents.map((incident) => {
                          const blockchain = incident.blockchain;

                          return (
                            <tr key={incident.incident_id}>
                              <td>
                                <div className="tm-incident-cell">
                                  <span className="tm-incident-file">⛓</span>
                                  <div>
                                    <strong>{incident.title}</strong>
                                    <small>{incident.incident_id}</small>
                                  </div>
                                </div>
                              </td>

                              <td>
                                {blockchain?.transaction_hash ? (
                                  <a
                                    href={`https://testnet.mstscan.com/tx/${blockchain.transaction_hash}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="tm-table-action"
                                  >
                                    View transaction ↗
                                  </a>
                                ) : (
                                  "Unavailable"
                                )}
                              </td>

                              <td>
                                {blockchain?.block_number ?? "—"}
                              </td>

                              <td>
                                <span
                                  className={`tm-blockchain-status ${
                                    blockchain?.verified === true
                                      ? "verified"
                                      : blockchain?.verified === false
                                        ? "tampered"
                                        : "registered"
                                  }`}
                                >
                                  {blockchain?.verified === true
                                    ? "Verified"
                                    : blockchain?.verified === false
                                      ? "Mismatch"
                                      : "Registered"}
                                </span>
                              </td>

                              <td>
                                <button
                                  className="tm-table-action"
                                  onClick={() => openIncident(incident)}
                                >
                                  Open →
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="tm-inline-empty">
                    <strong>No blockchain evidence registered yet.</strong>
                    <p>
                      Register an investigation using the Evidence integrity
                      panel. It will appear here automatically.
                    </p>
                  </div>
                )}
              </section>

              {selectedIncident && (
                <div className="tm-detail-grid">
                  <section className="tm-panel tm-timeline-panel">
                    <div className="tm-panel-heading">
                      <div>
                        <h2>Incident timeline</h2>
                        <p>
                          {selectedIncident.timeline?.story ??
                            "Events ordered by timestamp"}
                        </p>
                      </div>

                      <span className="tm-small-count">
                        {timeline.length} events
                      </span>
                    </div>
                    {timeline.length ? (
                      <div className="tm-timeline">
                        {timeline.map((log, index) => (
                          <article
                            id={`tm-timeline-event-${index}`}
                            className={`tm-timeline-item ${
                              selectedTimelineIndex === index
                                ? "tm-timeline-item-selected"
                                : ""
                            }`}
                            key={`${log.timestamp ?? "time"}-${index}`}
                          >
                            <div
                              className={`tm-timeline-marker ${getLevelClass(
                                log.level
                              )}`}
                            >
                              {getLevelClass(log.level) === "error"
                                ? "!"
                                : "·"}
                            </div>

                            <div className="tm-timeline-content">
                                {selectedTimelineIndex === index && (
                                  <span className="tm-timeline-selected-label">
                                    Selected supporting evidence
                                  </span>
                                )}
                              <div className="tm-timeline-meta">
                                <span className="tm-timestamp">
                                  {formatDate(log.timestamp)}
                                </span>
                                <span
                                  className={`tm-level ${getLevelClass(
                                    log.level
                                  )}`}
                                >
                                  {getString(log.level, "INFO")}
                                </span>
                              </div>

                             <strong>
                                {getString(log.service, "Unknown service")}
                              </strong>

                              <p>
                                {getString(log.description) ||
                                  getString(log.message, "No message provided")}
                              </p>

                              {typeof log.event_type === "string" && (
                                <span className="tm-trace-id">
                                  {log.event_type.replace(/_/g, " ")}
                                </span>
                              )}

                              {typeof log.role === "string" && (
                                <span className="tm-trace-id">
                                  {log.role.replace(/_/g, " ")}
                                </span>
                              )}
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="tm-inline-empty">
                        No timeline events were returned.
                      </div>
                    )}
                  </section>

                  
                  <section className="tm-panel tm-hypotheses-panel">
                    <div className="tm-panel-heading">
                      <div>
                        <h2>Possible root causes</h2>
                        <p>
                          Evidence-backed explanations identified by TraceMind
                        </p>
                      </div>

                      <span className="tm-small-count">
                        {hypotheses.length} findings
                      </span>
                    </div>

                    {hypotheses.length ? (
                      <div className="tm-hypothesis-list">
                        {hypotheses.map((hypothesis, index) => {
                          const score =
                            typeof hypothesis.investigation_score === "number"
                              ? hypothesis.investigation_score
                              : typeof hypothesis.score === "number"
                                ? hypothesis.score
                                : typeof hypothesis.confidence === "number"
                                  ? hypothesis.confidence
                                  : null;

                          const evidence = Array.isArray(hypothesis.evidence)
                            ? hypothesis.evidence
                            : Array.isArray(hypothesis.supporting_evidence)
                              ? hypothesis.supporting_evidence
                              : [];

                          const nextChecks = Array.isArray(hypothesis.next_checks)
                            ? hypothesis.next_checks
                            : [];

                          const alternatives = Array.isArray(
                            hypothesis.alternative_explanations
                          )
                            ? hypothesis.alternative_explanations
                            : [];

                          const breakdown = isObject(hypothesis.score_breakdown)
                            ? hypothesis.score_breakdown
                            : null;

                          const reason = getString(
                            hypothesis.why_suspected,
                            getString(
                              hypothesis.reason,
                              getString(hypothesis.explanation, "")
                            )
                          );

                          const status = getString(
                            hypothesis.investigation_status,
                            "unverified"
                          );

                          const role = getString(
                            hypothesis.investigation_role,
                            "uncertain"
                          );

                          const rankingLabel = getString(
                            hypothesis.ranking_label,
                            index === 0 ? "Leading hypothesis" : "Alternative hypothesis"
                          );

                          const scorePercent =
                            score === null
                              ? null
                              : Math.round(Math.max(0, Math.min(score, 1)) * 100);

                          return (
                            <article
                              className={`tm-hypothesis ${
                                index === 0 ? "tm-hypothesis-leading" : ""
                              }`}
                              key={`${hypothesis.cause ?? "cause"}-${index}`}
                            >
                              <div className="tm-hypothesis-number">
                                {String(index + 1).padStart(2, "0")}
                              </div>

                              <div className="tm-hypothesis-body">
                                <div className="tm-hypothesis-title">
                                  <strong>
                                    {getString(hypothesis.cause, "Possible cause")}
                                  </strong>

                                  <span className="tm-hypothesis-status">
                                    {status.replace(/_/g, " ")}
                                  </span>
                                </div>

                                <div className="tm-hypothesis-tags">
                                  <span className="tm-hypothesis-tag">
                                    {rankingLabel}
                                  </span>

                                  <span className="tm-hypothesis-tag">
                                    {role.replace(/_/g, " ")}
                                  </span>
                                </div>

                                {scorePercent !== null && (
                                  <div className="tm-investigation-score">
                                    <div className="tm-score-header">
                                      <strong>Investigation score</strong>
                                      <strong>{scorePercent}/100</strong>
                                    </div>

                                    <div className="tm-score-track">
                                      <div
                                        className="tm-score-fill"
                                        style={{ width: `${scorePercent}%` }}
                                      />
                                    </div>

                                    <small>
                                      {getString(
                                        hypothesis.confidence_label,
                                        "Relative evidence support"
                                      )} · Ranking score, not probability
                                    </small>
                                  </div>
                                )}

                                {typeof hypothesis.service === "string" && (
                                  <div className="tm-hypothesis-service">
                                    Affected service: <strong>{hypothesis.service}</strong>
                                  </div>
                                )}

                                {reason && (
                                  <div className="tm-hypothesis-explanation">
                                    <strong>Why TraceMind suspects this</strong>
                                    <p>{reason}</p>
                                  </div>
                                )}

                                {breakdown && (
                                  <details className="tm-investigation-details">
                                    <summary>How was this score calculated?</summary>

                                    <div className="tm-breakdown-list">
                                      {Object.entries(breakdown).map(([key, value]) => (
                                        <div className="tm-breakdown-row" key={key}>
                                          <span>{key.replace(/_/g, " ")}</span>
                                          <strong>
                                            {typeof value === "number"
                                              ? value > 0
                                                ? `+${value.toFixed(2)}`
                                                : value.toFixed(2)
                                              : String(value)}
                                          </strong>
                                        </div>
                                      ))}
                                    </div>
                                  </details>
                                )}

                                {evidence.length > 0 && (
                                  <details className="tm-evidence-details">
                                    <summary>
                                      View supporting evidence ({evidence.length})
                                    </summary>

                                    <ul className="tm-evidence-list">
                                      {evidence.map((entry, i) =>
                                        renderEvidence(entry, i)
                                      )}
                                    </ul>
                                  </details>
                                )}

                                {nextChecks.length > 0 && (
                                  <div className="tm-hypothesis-section">
                                    <strong>Recommended next checks</strong>

                                    <ol className="tm-next-checks">
                                      {nextChecks.map((check, i) => (
                                        <li key={i}>{check}</li>
                                      ))}
                                    </ol>
                                  </div>
                                )}

                                {alternatives.length > 0 && (
                                  <details className="tm-investigation-details">
                                    <summary>
                                      Other possible explanations ({alternatives.length})
                                    </summary>

                                    <ul className="tm-alternative-list">
                                      {alternatives.map((alternative, i) => (
                                        <li key={i}>{alternative}</li>
                                      ))}
                                    </ul>
                                  </details>
                                )}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="tm-inline-empty">
                        <div className="tm-empty-icon small">⌕</div>
                        <strong>No structured hypotheses returned</strong>
                        <p>
                          The backend did not identify a meaningful cause.
                          Review the timeline and upload additional logs if needed.
                        </p>
                      </div>
                    )}
                  </section>


                  <section className="tm-panel">
                    <div className="tm-panel-heading">
                      <div>
                        <h2>Timeline insights</h2>
                        <p>Summary of events detected by TraceMind</p>
                      </div>
                    </div>

                    <div className="tm-metrics">
                      <article className="tm-metric-card">
                        <div className="tm-metric-label">Total events</div>
                        <div className="tm-metric-value">
                          {selectedIncident.timeline?.event_count ?? timeline.length}
                        </div>
                      </article>

                      <article className="tm-metric-card">
                        <div className="tm-metric-label">Failure events</div>
                        <div className="tm-metric-value">
                          {selectedIncident.timeline?.failure_count ?? 0}
                        </div>
                      </article>

                      <article className="tm-metric-card">
                        <div className="tm-metric-label">First observed failure</div>
                        <div className="tm-metric-value">
                          {formatDate(
                            selectedIncident.timeline?.first_failure_timestamp ?? undefined
                          )}
                        </div>
                      </article>
                    </div>
                  </section>
                </div>
              )}

              <section className="tm-panel tm-history-panel">
                <div className="tm-panel-heading">
                  <div>
                    <h2>Recent investigations</h2>
                    <p>Your latest investigations saved in this browser</p>
                  </div>

                  {incidents.length > 0 && (
                    <button
                      className="tm-text-button"
                      onClick={() => setActivePage("investigations")}
                    >
                      View all →
                    </button>
                  )}
                </div>

                {incidents.length ? (
                  <div className="tm-table-wrap">
                    <table className="tm-table">
                      <thead>
                        <tr>
                          <th>Incident</th>
                          <th>Severity</th>
                          <th>Log events</th>
                          <th>Created</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {incidents.slice(0, 5).map((incident) => (
                          <tr key={incident.incident_id}>
                            <td>
                              <div className="tm-incident-cell">
                                <span className="tm-incident-file">▤</span>
                                <div>
                                  <strong>{incident.title}</strong>
                                  <small>{incident.incident_id}</small>
                                </div>
                              </div>
                            </td>
                            <td>
                              <span
                                className={`tm-severity ${getSeverityClass(
                                  incident.severity
                                )}`}
                              >
                                {incident.severity}
                              </span>
                            </td>
                            <td>{incident.logs.length}</td>
                            <td>{formatDate(incident.created_at)}</td>
                            <td>
                              <button
                                className="tm-table-action"
                                onClick={() => openIncident(incident)}
                              >
                                Open →
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="tm-inline-empty">
                    Your saved investigations will appear here.
                  </div>
                )}
              </section>
            </>
          ) : (
            <>
              <section className="tm-page-heading">
                <div>
                  <div className="tm-eyebrow">WORKSPACE</div>
                  <h1>All investigations</h1>
                  <p>
                    Search, filter, and reopen investigations saved in this
                    browser.
                  </p>
                </div>

                <button
                  className="tm-button tm-button-primary"
                  onClick={() => {
                    setActivePage("overview");
                    setShowUpload(true);
                  }}
                >
                  ＋ New investigation
                </button>
              </section>

              {error && (
                <div className="tm-alert tm-alert-error" role="alert">
                  <span>!</span>
                  <p>{error}</p>
                </div>
              )}

              {notice && (
                <div className="tm-alert tm-alert-success" role="status">
                  <span>✓</span>
                  <p>{notice}</p>
                </div>
              )}

              <section className="tm-panel tm-investigations-panel">
                <div className="tm-list-toolbar">
                  <div className="tm-search-box">
                    <span>⌕</span>
                    <input
                      type="search"
                      placeholder="Search by incident name or ID..."
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                    />
                  </div>

                  <select
                    className="tm-filter-select"
                    value={severityFilter}
                    onChange={(event) => setSeverityFilter(event.target.value)}
                    aria-label="Filter by severity"
                  >
                    <option value="all">All severities</option>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>

                  {incidents.length > 0 && (
                    <button
                      className="tm-text-button tm-danger-text"
                      onClick={deleteHistory}
                    >
                      Clear history
                    </button>
                  )}
                </div>

                <div className="tm-table-wrap">
                  <table className="tm-table">
                    <thead>
                      <tr>
                        <th>Incident</th>
                        <th>Severity</th>
                        <th>Log events</th>
                        <th>Created</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredIncidents.map((incident) => (
                        <tr key={incident.incident_id}>
                          <td>
                            <div className="tm-incident-cell">
                              <span className="tm-incident-file">▤</span>
                              <div>
                                <strong>{incident.title}</strong>
                                <small>{incident.incident_id}</small>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span
                              className={`tm-severity ${getSeverityClass(
                                incident.severity
                              )}`}
                            >
                              {incident.severity}
                            </span>
                          </td>
                          <td>{incident.logs.length}</td>
                          <td>{formatDate(incident.created_at)}</td>
                          <td>
                            <button
                              className="tm-table-action"
                              onClick={() => openIncident(incident)}
                            >
                              Open →
                            </button>
                          </td>
                        </tr>
                      ))}

                      {!filteredIncidents.length && (
                        <tr>
                          <td colSpan={5}>
                            <div className="tm-inline-empty">
                              {incidents.length
                                ? "No investigations match your search."
                                : "No investigations saved yet. Load the demo incident or upload a JSON file."}
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="tm-table-footer">
                  Showing {filteredIncidents.length} of {incidents.length}{" "}
                  investigations
                </div>
              </section>
            </>
          )}

          <footer className="tm-footer">
            <span>TraceMind</span>
            <span>AI-powered incident investigation</span>
            <span>Evidence first. Conclusions second.</span>
          </footer>
        </div>
      </section>
    </main>
  );
}