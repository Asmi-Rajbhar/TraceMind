"use client";

type TimelineEvent = {
  sequence: number;
  timestamp: string | null;
  service: string;
  level: string;
  event_type: string;
  trace_id?: string | null;
  message: string;
  role: string;
  description: string;
};

type TimelineData = {
  story: string;
  event_count: number;
  failure_count: number;
  events: TimelineEvent[];
};

export default function IncidentTimeline({
  timeline,
}: {
  timeline: TimelineData;
}) {
  if (!timeline || !timeline.events) {
    return null;
  }

  return (
    <section className="rounded-xl border p-5 space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Incident Timeline</h2>
        <p className="text-sm text-gray-500">{timeline.story}</p>
      </div>

      <div className="flex gap-6 text-sm">
        <p>Events: {timeline.event_count}</p>
        <p>Failures: {timeline.failure_count}</p>
      </div>

      <div className="space-y-4">
        {timeline.events.map((event) => {
          const isFailure =
            event.role === "failure" ||
            event.role === "first_observed_failure" ||
            event.role === "subsequent_failure";

          return (
            <div
              key={`${event.sequence}-${event.timestamp ?? "unknown"}`}
              className="flex gap-3"
            >
              <div
                className={`mt-1 h-3 w-3 shrink-0 rounded-full ${
                  isFailure ? "bg-red-500" : "bg-emerald-500"
                }`}
              />

              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-500">
                  {event.timestamp
                    ? new Date(event.timestamp).toLocaleString()
                    : "Timestamp unavailable"}
                </p>

                <p className="font-medium">{event.service}</p>

                <p className="text-sm">{event.description}</p>

                <p className="mt-1 text-xs text-gray-500">
                  {event.level} · {event.event_type}
                  {event.trace_id ? ` · ${event.trace_id}` : ""}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}