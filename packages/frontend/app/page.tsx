"use client";

import { jsPDF } from "jspdf";

import {
  ChangeEvent,
  DragEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  useAccount,
  useConnect,
  useDisconnect,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import { mstTestnet } from "@/lib/chains";

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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

const STORAGE_KEY = "tracemind-investigations-v1";

/* Small inline icon set, replacing the text glyphs used before. */

type IconName =
  | "overview"
  | "list"
  | "plus"
  | "close"
  | "check"
  | "alert"
  | "upload"
  | "search"
  | "refresh"
  | "chevron";

const ICON_PATHS: Record<IconName, ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 20h16" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 10-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </>
  ),
  chevron: <path d="M6 9l6 6 6-6" />,
};

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function getLogArray(value: unknown): LogEntry[] {
  return Array.isArray(value) ? (value.filter(isObject) as LogEntry[]) : [];
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

function formatClock(value?: string): string {
  if (!value) return "--:--:--";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleTimeString([], { hour12: false });
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

  const possibleKeys = ["hypotheses", "root_causes", "possible_causes", "findings"];

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

  const possibleKeys = ["summary", "analysis", "conclusion", "root_cause", "description"];

  for (const key of possibleKeys) {
    const value = result[key];

    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "TraceMind has processed the logs. Review the timeline and evidence to understand the possible cause.";
}

function getTimeline(incident: Investigation): TimelineEvent[] {
  if (incident.timeline?.events?.length) {
    return incident.timeline.events;
  }

  return [...incident.logs].sort((a, b) => {
    const first = new Date(a.timestamp ?? "").getTime();
    const second = new Date(b.timestamp ?? "").getTime();

    return (Number.isNaN(first) ? 0 : first) - (Number.isNaN(second) ? 0 : second);
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

function findEvidenceTimelineIndex(entry: unknown, timeline: TimelineEvent[]): number {
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
    const eventMessage = (getString(event.message) || getString(event.description))
      .toLowerCase()
      .trim();
    const eventTraceId = getString(event.trace_id).toLowerCase().trim();

    if (evidenceTimestamp && eventTimestamp && evidenceTimestamp === eventTimestamp) {
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
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState<number | null>(null);

  const [activePage, setActivePage] = useState<"overview" | "investigations">("overview");

  const [searchQuery, setSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  const [loading, setLoading] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [blockchainResult, setBlockchainResult] = useState<BlockchainResult | null>(null);

  const [blockchainLoading, setBlockchainLoading] = useState<
    "register" | "verify" | null
  >(null);

  const [blockchainError, setBlockchainError] = useState("");

  const { address, isConnected, chainId } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();

  const [relayLoading, setRelayLoading] = useState(false);

  const [apiStatus, setApiStatus] = useState<"checking" | "online" | "offline">(
    "checking",
  );

  const [showUpload, setShowUpload] = useState(false);

  const [timelineQuery, setTimelineQuery] = useState("");
  const [timelineService, setTimelineService] = useState("all");
  const [timelineLevel, setTimelineLevel] = useState<"all" | "errors">("all");
  const [compactTimeline, setCompactTimeline] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);

      if (saved) {
        const parsed: unknown = JSON.parse(saved);

        if (Array.isArray(parsed)) {
          const validIncidents = parsed
            .map(normalizeIncident)
            .filter((item): item is Investigation => item !== null);

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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(incidents));
    } catch (err) {
      console.error("Could not save investigation history:", err);
    }
  }, [incidents, historyLoaded]);

  const selectedIncident = useMemo(() => {
    return (
      incidents.find((item) => item.incident_id === selectedId) ?? incidents[0] ?? null
    );
  }, [incidents, selectedId]);

  const registeredIncidents = useMemo(() => {
    return incidents.filter(
      (incident) =>
        incident.blockchain?.registered === true &&
        Boolean(incident.blockchain?.transaction_hash),
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
        severityFilter === "all" || incident.severity.toLowerCase() === severityFilter;

      return matchesQuery && matchesSeverity;
    });
  }, [incidents, searchQuery, severityFilter]);

  const selectedInvestigation = selectedIncident?.investigation;
  const hypotheses = selectedIncident ? getHypotheses(selectedInvestigation) : [];

  const timeline = selectedIncident ? getTimeline(selectedIncident) : [];

  const timelineServices = Array.from(
    new Set(timeline.map((event) => getString(event.service)).filter(Boolean)),
  ).sort();

  const timelineQueryText = timelineQuery.trim().toLowerCase();

  const visibleTimeline = timeline
    .map((log, index) => ({ log, index }))
    .filter(({ log }) => {
      if (timelineLevel === "errors" && getLevelClass(log.level) !== "error") {
        return false;
      }

      if (timelineService !== "all" && getString(log.service) !== timelineService) {
        return false;
      }

      if (!timelineQueryText) return true;

      return [
        log.service,
        log.message,
        log.description,
        log.trace_id,
        log.event_type,
        log.role,
      ].some((value) => getString(value).toLowerCase().includes(timelineQueryText));
    });

  const timelineFiltered =
    timelineLevel !== "all" || timelineService !== "all" || timelineQueryText !== "";

  const clearTimelineFilters = () => {
    setTimelineQuery("");
    setTimelineService("all");
    setTimelineLevel("all");
  };

  useEffect(() => {
    setTimelineQuery("");
    setTimelineService("all");
    setTimelineLevel("all");
    setTimelineCollapsed(false);
  }, [selectedIncident?.incident_id]);

  const handleRelayedRegistration = async () => {
    if (!selectedIncident) return;

    if (!isObject(selectedIncident.investigation)) {
      setBlockchainError("Investigation report is not available.");
      return;
    }

    setRelayLoading(true);
    setBlockchainError("");
    setNotice("");
    setBlockchainResult(null);

    try {
      // 1. Connect MetaMask if it is not connected.
      let walletAddress = address;

      if (!isConnected || !walletAddress) {
        const injectedConnector = connectors.find(
          (connector) =>
            connector.id === "io.metamask" ||
            connector.name.toLowerCase().includes("metamask"),
        );

        if (!injectedConnector) {
          throw new Error(
            "MetaMask connector not found. Please check your wallet configuration.",
          );
        }

        const connection = await connectAsync({
          connector: injectedConnector,
        });

        walletAddress = connection.accounts[0];
      }

      if (!walletAddress) {
        throw new Error("Could not get your wallet address.");
      }

      // 2. Switch to MST Testnet.
      if (chainId !== mstTestnet.id) {
        await switchChainAsync({ chainId: mstTestnet.id });
      }

      // 3. Ask the backend to prepare the EIP-712 request.
      const prepareResponse = await fetch(
        `${API_BASE}/api/evidence/relay/prepare`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            incident_id: selectedIncident.incident_id,
            logs: selectedIncident.logs,
            report: selectedIncident.investigation,
            sender: walletAddress,
          }),
        },
      );

      const prepared: unknown = await prepareResponse.json();

      if (!prepareResponse.ok || !isObject(prepared)) {
        const detail =
          isObject(prepared) && typeof prepared.detail === "string"
            ? prepared.detail
            : "Could not prepare the signing request.";

        throw new Error(detail);
      }

      // The backend returns the EIP-712 data and request nonce/deadline.
      const typedData = prepared.typed_data;
      const request = prepared.request;

      if (!isObject(typedData) || !isObject(request)) {
        throw new Error("Invalid signing request returned by the backend.");
      }

      if (
        !isObject(typedData.domain) ||
        !isObject(typedData.types) ||
        !isObject(typedData.message) ||
        typeof typedData.primaryType !== "string" ||
        typeof request.nonce !== "number" ||
        typeof request.deadline !== "number"
      ) {
        throw new Error("The backend returned an incomplete EIP-712 request.");
      }

      // 4. Ask MetaMask to sign the typed request.
      const signature = await signTypedDataAsync({
        domain: typedData.domain as any,
        types: typedData.types as any,
        primaryType: typedData.primaryType as any,
        message: typedData.message as any,
      });

      // 5. Submit the user's signature through the backend relayer.
      const submitResponse = await fetch(
        `${API_BASE}/api/evidence/relay/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            incident_id: selectedIncident.incident_id,
            logs: selectedIncident.logs,
            report: selectedIncident.investigation,
            sender: walletAddress,
            nonce: request.nonce,
            deadline: request.deadline,
            signature,
          }),
        },
      );

      const submitted: unknown = await submitResponse.json();

      if (!submitResponse.ok || !isObject(submitted)) {
        const detail =
          isObject(submitted) && typeof submitted.detail === "string"
            ? submitted.detail
            : "Relayed registration failed.";

        throw new Error(detail);
      }

      const result = submitted as unknown as BlockchainResult;

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
            : incident,
        ),
      );

      setNotice("Evidence registered through MetaMask on MST Testnet.");
    } catch (err) {
      setBlockchainError(
        err instanceof Error
          ? err.message
          : "MetaMask registration failed.",
      );
    } finally {
      setRelayLoading(false);
    }
  };

  const handleRelayedVerification = async () => {
    if (!selectedIncident || !isObject(selectedIncident.investigation)) {
      setBlockchainError("Investigation report is not available.");
      return;
    }

    setRelayLoading(true);
    setBlockchainError("");
    setBlockchainResult(null);

    try {
      const response = await fetch(`${API_BASE}/api/evidence/verify-2771`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incident_id: selectedIncident.incident_id,
          logs: selectedIncident.logs,
          report: selectedIncident.investigation,
        }),
      });

      const data: unknown = await response.json();

      if (!response.ok || !isObject(data)) {
        throw new Error(
          isObject(data) && typeof data.detail === "string"
            ? data.detail
            : "Evidence verification failed.",
        );
      }

      const result = data as unknown as BlockchainResult;
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
            : incident,
        ),
      );

      setNotice(
        result.verified
          ? "Evidence integrity verified on MST Testnet."
          : "Evidence verification did not pass.",
      );
    } catch (err) {
      setBlockchainError(
        err instanceof Error ? err.message : "Verification failed.",
      );
    } finally {
      setRelayLoading(false);
    }
  };

  const handleBlockchainAction = async (action: "register" | "verify") => {
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
      const response = await fetch(`${API_BASE}/api/evidence/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          incident_id: selectedIncident.incident_id,
          logs: selectedIncident.logs,
          report: selectedIncident.investigation,
        }),
      });

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
            : incident,
        ),
      );

      if (action === "register") {
        setNotice("Evidence registered on MST Testnet.");
      }
    } catch (err) {
      setBlockchainError(
        err instanceof Error ? err.message : "Blockchain operation failed.",
      );
    } finally {
      setBlockchainLoading(null);
    }
  };

  useEffect(() => {
    if (selectedTimelineIndex === null) return;

    const element = document.getElementById(`tm-timeline-event-${selectedTimelineIndex}`);

    element?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [selectedTimelineIndex]);

  const handleEvidenceClick = (entry: unknown) => {
    const matchingIndex = findEvidenceTimelineIndex(entry, timeline);

    if (matchingIndex === -1) {
      setNotice("No exact match for this evidence was found in the timeline.");
      return;
    }

    setNotice("");
    clearTimelineFilters();
    setTimelineCollapsed(false);
    setSelectedTimelineIndex(matchingIndex);
  };

  const summary = selectedIncident
    ? getSummary(selectedInvestigation)
    : "Upload log files or load the demo incident to begin your investigation.";

  const uniqueServices = new Set(
    selectedIncident?.logs.map((log) => getString(log.service)).filter(Boolean) ?? [],
  );

  const errorCount =
    selectedIncident?.logs.filter((log) => {
      const level = getString(log.level).toLowerCase();
      return level.includes("error") || level.includes("fatal");
    }).length ?? 0;

  const saveIncident = useCallback((incident: Investigation) => {
    setIncidents((previous) => {
      const withoutDuplicate = previous.filter(
        (item) => item.incident_id !== incident.incident_id,
      );

      return [incident, ...withoutDuplicate];
    });

    setSelectedId(incident.incident_id);
    setActivePage("overview");
    setShowUpload(false);
    setSelectedFile(null);
    setError("");
    setNotice("Investigation saved in this browser.");
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
          : "Could not load the demo incident.",
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
        throw new Error("The JSON file must contain an array of log events.");
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
        selectedFile.name.replace(/\.json$/i, "").replace(/[_-]/g, " ") || incident.title;

      incident.created_at = new Date().toISOString();

      saveIncident(incident);
      setApiStatus("online");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong while investigating the logs.",
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
    const confirmed = window.confirm("Clear all investigations saved in this browser?");

    if (!confirmed) return;

    setIncidents([]);
    setSelectedId(null);
    setNotice("Browser investigation history cleared.");
    setError("");
  };

  

  const downloadInvestigationReport = () => {
    if (!selectedIncident) return;

    const incident = selectedIncident;
    const findings = getHypotheses(incident.investigation);
    const events = getTimeline(incident);

    const scoreLabel = (value: unknown) => {
      if (typeof value !== "number") return "Not available";
      return `${Math.round(value <= 1 ? value * 100 : value)}%`;
    };

    const findingSections = findings.map((item, index) => {
      const score =
        item.score ?? item.investigation_score ?? item.confidence;

      const reason =
        item.reason ?? item.why_suspected ?? item.explanation;

      const evidence =
        item.supporting_evidence ?? item.evidence;

      return [
        `### ${index + 1}. ${getString(item.cause, "Possible root cause")}`,
        `- Service: ${getString(item.service, "Not specified")}`,
        `- Confidence: ${scoreLabel(score)}`,
        `- Explanation: ${getString(reason, "Not provided")}`,
        `- Evidence: ${
          Array.isArray(evidence)
            ? evidence.map((e) =>
                typeof e === "string" ? e : JSON.stringify(e)
              ).join("; ")
            : "Not provided"
        }`,
        `- Next checks: ${
          Array.isArray(item.next_checks)
            ? item.next_checks.join("; ")
            : "Not provided"
        }`,
        `- Alternative explanations: ${
          Array.isArray(item.alternative_explanations)
            ? item.alternative_explanations.join("; ")
            : "Not provided"
        }`,
      ].join("\n");
    });

    const timelineSection = events.map((event, index) =>
      [
        `${index + 1}. ${formatDate(event.timestamp)}`,
        `   Service: ${getString(event.service, "Unknown")}`,
        `   Level: ${getString(event.level, "INFO")}`,
        `   Event: ${getString(
          event.message,
          event.description ?? "No description"
        )}`,
      ].join("\n")
    ).join("\n");

    const report = [
      "TRACEMIND INVESTIGATION REPORT",
      "",
      "INCIDENT DETAILS",
      `Incident ID: ${incident.incident_id}`,
      `Title: ${incident.title}`,
      `Severity: ${incident.severity}`,
      `Created: ${formatDate(incident.created_at)}`,
      `Total log events: ${incident.logs.length}`,
      "",
      "INVESTIGATION SUMMARY",
      summary,
      "",
      "POSSIBLE ROOT CAUSES",
      findingSections.length
        ? findingSections.join("\n\n")
        : "No structured root-cause findings available.",
      "",
      "INCIDENT TIMELINE",
      timelineSection || "No timeline events available.",
      "",
      "ORIGINAL LOG EVIDENCE",
      JSON.stringify(incident.logs, null, 2),
      "",
      "Generated by TraceMind.",
      "AI-generated findings should be reviewed against the original logs.",
    ].join("\n");

    const pdf = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4",
    });

    const margin = 15;
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const maxWidth = pageWidth - margin * 2;

    let y = 20;

    // Report heading
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(18);
    pdf.text("TraceMind", margin, y);

    y += 8;

    pdf.setFontSize(13);
    pdf.text("Investigation Report", margin, y);

    y += 10;

    // Divider
    pdf.setDrawColor(28, 107, 60);
    pdf.setLineWidth(0.7);
    pdf.line(margin, y, pageWidth - margin, y);

    y += 10;

    // Report content
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);

    const lines = report.split("\n");

    for (const line of lines) {
      const cleanLine = line
        .replace(/^#{1,6}\s*/, "")
        .replace(/\*\*/g, "")
        .replace(/```/g, "");

      if (!cleanLine.trim()) {
        y += 3;
        continue;
      }

      const isHeading =
        /^(TRACEMIND INVESTIGATION REPORT|INCIDENT DETAILS|INVESTIGATION SUMMARY|POSSIBLE ROOT CAUSES|INCIDENT TIMELINE|ORIGINAL LOG EVIDENCE)$/.test(
          cleanLine
        );

      if (isHeading) {
        y += 3;
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(11);
      } else {
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
      }

      const wrappedLines = pdf.splitTextToSize(
        cleanLine,
        maxWidth
      );

      for (const wrappedLine of wrappedLines) {
        if (y > pageHeight - margin) {
          pdf.addPage();
          y = 20;
        }

        pdf.text(wrappedLine, margin, y);
        y += 5;
      }
    }

    // Page numbers
    const totalPages = pdf.getNumberOfPages();

    for (let page = 1; page <= totalPages; page++) {
      pdf.setPage(page);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);

      pdf.text(
        `TraceMind | Page ${page} of ${totalPages}`,
        pageWidth / 2,
        pageHeight - 8,
        { align: "center" }
      );
    }

    // Download PDF
    pdf.save(`${incident.incident_id}-report.pdf`);
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
              <strong>{getString(entry.service, "Unknown service")}</strong>

              {typeof entry.level === "string" && (
                <span className={`tm-level ${getLevelClass(entry.level)}`}>
                  {entry.level}
                </span>
              )}
            </div>

            {typeof entry.message === "string" && <p>{entry.message}</p>}

            <small>
              {getString(entry.timestamp)}
              {typeof entry.trace_id === "string" ? `  trace ${entry.trace_id}` : ""}
            </small>

            <button
              type="button"
              className="tm-evidence-link"
              onClick={() => handleEvidenceClick(entry)}
            >
              Show in timeline
            </button>
          </div>
        </li>
      );
  };

  const renderIncidentRows = (rows: Investigation[]) =>
    rows.map((incident) => (
      <tr key={incident.incident_id}>
        <td>
          <div className="tm-incident-cell">
            <strong>{incident.title}</strong>
            <small>{incident.incident_id}</small>
          </div>
        </td>
        <td>
          <span className={`tm-severity ${getSeverityClass(incident.severity)}`}>
            {incident.severity}
          </span>
        </td>
        <td className="num">{incident.logs.length}</td>
        <td>{formatDate(incident.created_at)}</td>
        <td>
          <button className="tm-table-action" onClick={() => openIncident(incident)}>
            Open
          </button>
        </td>
      </tr>
    ));

  const incidentTableHead = (
    <thead>
      <tr>
        <th>Incident</th>
        <th>Severity</th>
        <th>Log events</th>
        <th>Created</th>
        <th />
      </tr>
    </thead>
  );

  const blockchainState =
    blockchainResult?.verified === true
      ? "verified"
      : blockchainResult?.verified === false && blockchainResult.registered
        ? "tampered"
        : blockchainResult?.registered
          ? "registered"
          : "";

  const blockchainStateLabel =
    blockchainState === "verified"
      ? "Verified"
      : blockchainState === "tampered"
        ? "Mismatch detected"
        : blockchainState === "registered"
          ? "Registered"
          : "Not checked";

  return (
    <main className="tm-app">
      <header className="tm-topbar">
        <div className="tm-topbar-inner">
          <div className="tm-brand">
            <svg
              width="22"
              height="22"
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
            TraceMind
          </div>

          <nav className="tm-nav" aria-label="Main">
            <button
              className={`tm-nav-item ${activePage === "overview" ? "active" : ""}`}
              onClick={() => setActivePage("overview")}
            >
              <Icon name="overview" />
              Overview
            </button>

            <button
              className={`tm-nav-item ${activePage === "investigations" ? "active" : ""}`}
              onClick={() => setActivePage("investigations")}
            >
              <Icon name="list" />
              Investigations
              <span className="tm-nav-count">{incidents.length}</span>
            </button>
          </nav>

          <div className="tm-topbar-actions">
            <span className="tm-connection">
              <span className={`tm-status-dot ${apiStatus}`} />
              {apiStatus === "online"
                ? "Backend connected"
                : apiStatus === "offline"
                  ? "Backend offline"
                  : "Checking backend"}
            </span>

            <button
              className="tm-button tm-button-primary"
              onClick={() => {
                setActivePage("overview");
                setShowUpload(true);
                setError("");
                setNotice("");
              }}
            >
              <Icon name="plus" size={15} />
              New investigation
            </button>
          </div>
        </div>
      </header>

      <div className="tm-page">
        {activePage === "overview" ? (
          <>
            <section className="tm-page-heading">
              <div>
                <h1>Incident overview</h1>
                <p>
                  What happened, which causes are most likely, and the log lines behind
                  each finding.
                </p>
              </div>

              <button
                className="tm-button tm-button-secondary"
                onClick={loadDemo}
                disabled={loadingDemo}
              >
                <Icon name="refresh" size={15} />
                {loadingDemo ? "Loading..." : "Load demo incident"}
              </button>
            </section>

            {error && (
              <div className="tm-alert tm-alert-error" role="alert">
                <Icon name="alert" />
                <div className="tm-alert-body">
                  <strong>Something went wrong</strong>
                  {error}
                </div>
                <button
                  className="tm-icon-button"
                  onClick={() => setError("")}
                  aria-label="Dismiss error"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}

            {notice && (
              <div className="tm-alert tm-alert-success" role="status">
                <Icon name="check" />
                <div className="tm-alert-body">{notice}</div>
                <button
                  className="tm-icon-button"
                  onClick={() => setNotice("")}
                  aria-label="Dismiss notice"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}

            <dl className="tm-facts">
              <div className="tm-fact">
                <dt>Saved investigations</dt>
                <dd>{incidents.length}</dd>
              </div>
              <div className="tm-fact">
                <dt>Log events</dt>
                <dd>{selectedIncident?.logs.length ?? 0}</dd>
              </div>
              <div className="tm-fact">
                <dt>Services involved</dt>
                <dd>{uniqueServices.size}</dd>
              </div>
              <div className="tm-fact">
                <dt>Error events</dt>
                <dd>{errorCount}</dd>
              </div>
            </dl>

            {showUpload && (
              <section className="tm-panel tm-upload-panel">
                <div className="tm-panel-heading">
                  <div>
                    <h2>Run a new investigation</h2>
                    <p>Upload a JSON file containing an array of log events.</p>
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
                    <Icon name="close" />
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
                  <Icon name={selectedFile ? "check" : "upload"} size={24} />

                  {selectedFile ? (
                    <>
                      <strong>{selectedFile.name}</strong>
                      <p>{(selectedFile.size / 1024).toFixed(1)} KB, ready to run</p>
                    </>
                  ) : (
                    <>
                      <strong>Drop your log file here</strong>
                      <p>JSON array of log events</p>
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
                  <p>The file is sent to your local FastAPI backend for analysis.</p>

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
                      "Run investigation"
                    )}
                  </button>
                </div>
              </section>
            )}

            <section className="tm-panel">
              {selectedIncident ? (
                <>
                  <div className="tm-report-head">
                    <div>
                      <h2>{selectedIncident.title}</h2>
                      <p className="tm-report-meta">
                        <code>{selectedIncident.incident_id}</code> with{" "}
                        {selectedIncident.logs.length} log events
                      </p>
                    </div>

                    {selectedIncident && (
                      <div className="tm-report-actions">
                        <button
                          className="tm-button tm-button-secondary"
                          onClick={downloadInvestigationReport}
                        >
                          ↓ Download report
                        </button>

                        <span
                          className={`tm-severity ${getSeverityClass(
                            selectedIncident.severity
                          )}`}
                        >
                          {selectedIncident.severity}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="tm-summary">
                    <p>{summary}</p>
                    <small>
                      Check AI-generated findings against the log evidence below.
                    </small>
                  </div>
                </>
              ) : (
                <div className="tm-empty-state">
                  <h3>No investigation open</h3>
                  <p>
                    Load the demo incident to look around, or upload a JSON file of your
                    own logs.
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
              <section className="tm-panel">
                <div className="tm-panel-heading">
                  <div>
                    <h2>Evidence integrity</h2>
                    <p>
                      Register this investigation on the MST blockchain, then verify later
                      that it has not changed.
                    </p>
                  </div>

                  <span className={`tm-blockchain-status ${blockchainState}`}>
                    {blockchainStateLabel}
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
                    <span>Evidence Registry (ERC-2771)</span>
                    <strong className="tm-blockchain-address">
                      0x7EC945b74B686a51B2f0469CD48f3113a8dfBFe2
                    </strong>
                  </div>

                  <div>
                    <span>MetaMask wallet</span>
                    <strong className="tm-blockchain-address">
                      {isConnected && address
                        ? `${address.slice(0, 8)}...${address.slice(-6)}`
                        : "Not connected"}
                    </strong>
                  </div>
                </div>

                <div className="tm-blockchain-actions">
                  {!isConnected ? (
                    <button
                      className="tm-button tm-button-primary"
                      onClick={handleRelayedRegistration}
                      disabled={relayLoading || blockchainLoading !== null}
                    >
                      {relayLoading ? "Connecting..." : "Connect & register evidence"}
                    </button>
                  ) : (
                    <>
                      <button
                        className="tm-button tm-button-primary"
                        onClick={handleRelayedRegistration}
                        disabled={relayLoading || blockchainLoading !== null}
                      >
                        {relayLoading ? "Registering..." : "Register with MetaMask"}
                      </button>

                      <button
                        className="tm-button tm-button-secondary"
                        onClick={handleRelayedVerification}
                        disabled={relayLoading || blockchainLoading !== null}
                      >
                        {relayLoading ? "Please wait..." : "Verify evidence"}
                      </button>

                      <button
                        className="tm-button tm-button-secondary"
                        onClick={() => disconnect()}
                        disabled={relayLoading}
                      >
                        Disconnect wallet
                      </button>
                    </>
                  )}
                </div>

                {isConnected && (
                  <p>
                    Connected to {chainId === mstTestnet.id ? "MST Testnet" : "another network"}.
                  </p>
                )}

                <div className="tm-blockchain-actions">
                  <button
                    className="tm-button tm-button-secondary"
                    onClick={() => handleBlockchainAction("register")}
                    disabled={blockchainLoading !== null || relayLoading}
                  >
                    Legacy registration (fallback)
                  </button>

                  <button
                    className="tm-button tm-button-secondary"
                    onClick={() => handleBlockchainAction("verify")}
                    disabled={blockchainLoading !== null || relayLoading}
                  >
                    Legacy verification (fallback)
                  </button>
                </div>

                {/* <div className="tm-blockchain-actions">
                  <button
                    className="tm-button tm-button-primary"
                    onClick={() => handleBlockchainAction("register")}
                    disabled={blockchainLoading !== null}
                  >
                    {blockchainLoading === "register"
                      ? "Registering..."
                      : "Register evidence"}
                  </button>

                  <button
                    className="tm-button tm-button-secondary"
                    onClick={() => handleBlockchainAction("verify")}
                    disabled={blockchainLoading !== null}
                  >
                    {blockchainLoading === "verify" ? "Verifying..." : "Verify evidence"}
                  </button>
                </div> */}

                {blockchainError && (
                  <div className="tm-blockchain-error">{blockchainError}</div>
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

                    {(blockchainResult.log_hash || blockchainResult.current_log_hash) && (
                      <div>
                        <span>Current log hash</span>
                        <code>
                          {blockchainResult.log_hash ?? blockchainResult.current_log_hash}
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

            {selectedIncident && (
              <div className="tm-detail-grid">
                <section className="tm-panel tm-timeline-panel">
                  <div className="tm-panel-heading">
                    <div>
                      <h2>Incident timeline</h2>
                      <p>
                        {selectedIncident.timeline?.story ||
                          "Events ordered by timestamp"}
                      </p>
                    </div>

                    <div className="tm-timeline-heading-actions">
                      <span className="tm-count">
                        {timelineFiltered
                          ? `${visibleTimeline.length} of ${timeline.length} events`
                          : `${timeline.length} events`}
                      </span>

                      <button
                        type="button"
                        className="tm-icon-button"
                        aria-expanded={!timelineCollapsed}
                        aria-label={
                          timelineCollapsed ? "Expand timeline" : "Collapse timeline"
                        }
                        onClick={() => setTimelineCollapsed((value) => !value)}
                      >
                        <Icon name="chevron" />
                      </button>
                    </div>
                  </div>

                  <dl className="tm-facts tm-facts-inline">
                    <div className="tm-fact">
                      <dt>Total events</dt>
                      <dd>{selectedIncident.timeline?.event_count ?? timeline.length}</dd>
                    </div>
                    <div className="tm-fact">
                      <dt>Failures</dt>
                      <dd>{selectedIncident.timeline?.failure_count ?? 0}</dd>
                    </div>
                    <div className="tm-fact">
                      <dt>First failure</dt>
                      <dd className="small">
                        {formatDate(
                          selectedIncident.timeline?.first_failure_timestamp ?? undefined,
                        )}
                      </dd>
                    </div>
                  </dl>

                  {!timelineCollapsed && (
                    <>
                      {timeline.length > 0 && (
                        <div className="tm-log-toolbar">
                          <div className="tm-log-search">
                            <Icon name="search" size={15} />
                            <input
                              type="search"
                              placeholder="Search events"
                              value={timelineQuery}
                              onChange={(event) => setTimelineQuery(event.target.value)}
                              aria-label="Search timeline events"
                            />
                          </div>

                          <select
                            className="tm-log-select"
                            value={timelineService}
                            onChange={(event) => setTimelineService(event.target.value)}
                            aria-label="Filter by service"
                          >
                            <option value="all">All services</option>
                            {timelineServices.map((service) => (
                              <option key={service} value={service}>
                                {service}
                              </option>
                            ))}
                          </select>

                          <div
                            className="tm-segmented"
                            role="group"
                            aria-label="Filter by level"
                          >
                            <button
                              type="button"
                              className={timelineLevel === "all" ? "active" : ""}
                              aria-pressed={timelineLevel === "all"}
                              onClick={() => setTimelineLevel("all")}
                            >
                              All
                            </button>
                            <button
                              type="button"
                              className={timelineLevel === "errors" ? "active" : ""}
                              aria-pressed={timelineLevel === "errors"}
                              onClick={() => setTimelineLevel("errors")}
                            >
                              Errors only
                            </button>
                          </div>

                          <button
                            type="button"
                            className={`tm-log-density ${
                              compactTimeline ? "active" : ""
                            }`}
                            aria-pressed={compactTimeline}
                            onClick={() => setCompactTimeline((value) => !value)}
                          >
                            Compact
                          </button>
                        </div>
                      )}

                      {timeline.length === 0 ? (
                        <div className="tm-inline-empty">
                          No timeline events were returned.
                        </div>
                      ) : visibleTimeline.length === 0 ? (
                        <div className="tm-inline-empty">
                          <strong>No events match these filters</strong>
                          <button
                            type="button"
                            className="tm-text-button"
                            onClick={clearTimelineFilters}
                          >
                            Clear filters
                          </button>
                        </div>
                      ) : (
                        <div className={`tm-log ${compactTimeline ? "compact" : ""}`}>
                          {visibleTimeline.map(({ log, index }) => {
                            const levelClass = getLevelClass(log.level);
                            const selected = selectedTimelineIndex === index;

                            return (
                              <article
                                id={`tm-timeline-event-${index}`}
                                className={`tm-log-row ${levelClass} ${
                                  selected ? "selected" : ""
                                }`}
                                key={`${log.timestamp ?? "time"}-${index}`}
                              >
                                <time
                                  className="tm-log-time"
                                  title={formatDate(log.timestamp)}
                                >
                                  {formatClock(log.timestamp)}
                                </time>

                                <span className="tm-log-level">
                                  {getString(log.level, "INFO")}
                                </span>

                                <div className="tm-log-body">
                                  {selected && (
                                    <span className="tm-log-selected-note">
                                      Supporting evidence
                                    </span>
                                  )}

                                  <span className="tm-log-service">
                                    {getString(log.service, "Unknown service")}
                                  </span>

                                  <p
                                    className="tm-log-message"
                                    title={
                                      getString(log.description) || getString(log.message)
                                    }
                                  >
                                    {getString(log.description) ||
                                      getString(log.message, "No message provided")}
                                  </p>

                                  {(typeof log.event_type === "string" ||
                                    typeof log.role === "string") && (
                                    <div className="tm-log-tags">
                                      {typeof log.event_type === "string" && (
                                        <span className="tm-log-tag">
                                          {log.event_type.replace(/_/g, " ")}
                                        </span>
                                      )}
                                      {typeof log.role === "string" && (
                                        <span className="tm-log-tag">
                                          {log.role.replace(/_/g, " ")}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </section>

                <section className="tm-panel">
                  <div className="tm-panel-heading">
                    <div>
                      <h2>Possible root causes</h2>
                      <p>Ranked by how much evidence supports each one</p>
                    </div>

                    <span className="tm-count">{hypotheses.length} findings</span>
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
                          hypothesis.alternative_explanations,
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
                            getString(hypothesis.explanation, ""),
                          ),
                        );

                        const status = getString(
                          hypothesis.investigation_status,
                          "unverified",
                        );

                        const role = getString(
                          hypothesis.investigation_role,
                          "uncertain",
                        );

                        const rankingLabel = getString(
                          hypothesis.ranking_label,
                          index === 0 ? "Leading hypothesis" : "Alternative hypothesis",
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
                            <div className="tm-hypothesis-rank">{index + 1}</div>

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
                                <span className="tm-tag">{rankingLabel}</span>
                                <span className="tm-tag">{role.replace(/_/g, " ")}</span>
                              </div>

                              {scorePercent !== null && (
                                <div className="tm-investigation-score">
                                  <div className="tm-score-header">
                                    <span>Investigation score</span>
                                    <span>{scorePercent}/100</span>
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
                                      "Relative evidence support",
                                    )}
                                    . This ranks causes against each other; it is not a
                                    probability.
                                  </small>
                                </div>
                              )}

                              {typeof hypothesis.service === "string" && (
                                <div className="tm-hypothesis-service">
                                  Affected service: <code>{hypothesis.service}</code>
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
                                  <summary>How the score was calculated</summary>

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
                                    Supporting evidence ({evidence.length})
                                  </summary>

                                  <ul className="tm-evidence-list">
                                    {evidence.map((entry, i) => renderEvidence(entry, i))}
                                  </ul>
                                </details>
                              )}

                              {nextChecks.length > 0 && (
                                <div className="tm-hypothesis-section">
                                  <strong>Next checks</strong>

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
                                    Other explanations ({alternatives.length})
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
                      <strong>No root causes identified</strong>
                      <p>
                        The backend did not find a likely cause. Check the timeline, or
                        upload more logs from around the failure.
                      </p>
                    </div>
                  )}
                </section>
              </div>
            )}

            <section className="tm-panel">
              <div className="tm-panel-heading">
                <div>
                  <h2>Blockchain evidence explorer</h2>
                  <p>Investigations registered on MST Testnet</p>
                </div>

                <span className="tm-count">{registeredIncidents.length} registered</span>
              </div>

              {registeredIncidents.length > 0 ? (
                <div className="tm-table-wrap">
                  <table className="tm-table">
                    <thead>
                      <tr>
                        <th>Incident</th>
                        <th>Transaction</th>
                        <th>Block</th>
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
                                <strong>{incident.title}</strong>
                                <small>{incident.incident_id}</small>
                              </div>
                            </td>

                            <td>
                              {blockchain?.transaction_hash ? (
                                <a
                                  href={`https://testnet.mstscan.com/tx/${blockchain.transaction_hash.startsWith("0x") ? blockchain.transaction_hash : `0x${blockchain.transaction_hash}`}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="tm-table-action"
                                >
                                  View on explorer
                                </a>
                              ) : (
                                "Unavailable"
                              )}
                            </td>

                            <td className="num">{blockchain?.block_number ?? "-"}</td>

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
                                Open
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
                  <strong>Nothing registered yet</strong>
                  <p>
                    Use Register evidence in the Evidence integrity section. The
                    investigation will show up here.
                  </p>
                </div>
              )}
            </section>

            <section className="tm-panel">
              <div className="tm-panel-heading">
                <div>
                  <h2>Recent investigations</h2>
                  <p>Saved in this browser</p>
                </div>

                {incidents.length > 0 && (
                  <button
                    className="tm-text-button"
                    onClick={() => setActivePage("investigations")}
                  >
                    View all
                  </button>
                )}
              </div>

              {incidents.length ? (
                <div className="tm-table-wrap">
                  <table className="tm-table">
                    {incidentTableHead}
                    <tbody>{renderIncidentRows(incidents.slice(0, 5))}</tbody>
                  </table>
                </div>
              ) : (
                <div className="tm-inline-empty">
                  Investigations you run will be listed here.
                </div>
              )}
            </section>
          </>
        ) : (
          <>
            <section className="tm-page-heading">
              <div>
                <h1>All investigations</h1>
                <p>Search, filter, and reopen investigations saved in this browser.</p>
              </div>
            </section>

            {error && (
              <div className="tm-alert tm-alert-error" role="alert">
                <Icon name="alert" />
                <div className="tm-alert-body">{error}</div>
              </div>
            )}

            {notice && (
              <div className="tm-alert tm-alert-success" role="status">
                <Icon name="check" />
                <div className="tm-alert-body">{notice}</div>
              </div>
            )}

            <section className="tm-panel">
              <div className="tm-list-toolbar">
                <div className="tm-search-box">
                  <Icon name="search" size={16} />
                  <input
                    type="search"
                    placeholder="Search by name, ID, or severity"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    aria-label="Search investigations"
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
                  {incidentTableHead}
                  <tbody>
                    {renderIncidentRows(filteredIncidents)}

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
                Showing {filteredIncidents.length} of {incidents.length} investigations
              </div>
            </section>
          </>
        )}

        <footer className="tm-footer">
          <span>TraceMind</span>
          <span>Findings are leads to check against the logs, not verdicts.</span>
        </footer>
      </div>
    </main>
  );
}