/**
 * Prometheus-compatible metrics collection
 */

interface MetricValue {
    value: number;
    labels: Record<string, string>;
    timestamp: number;
}

class MetricsCollector {
    private counters = new Map<string, MetricValue[]>();
    private gauges = new Map<string, MetricValue[]>();
    private histograms = new Map<string, MetricValue[]>();

    /**
     * Increment a counter metric
     */
    incrementCounter(name: string, labels: Record<string, string> = {}, value: number = 1) {
        const key = this.getKey(name, labels);
        const existing = this.counters.get(key) || [];
        const lastValue = existing.length > 0 ? existing[existing.length - 1].value : 0;

        existing.push({
            value: lastValue + value,
            labels,
            timestamp: Date.now(),
        });

        this.counters.set(key, existing);
    }

    /**
     * Set a gauge metric
     */
    setGauge(name: string, value: number, labels: Record<string, string> = {}) {
        const key = this.getKey(name, labels);
        const existing = this.gauges.get(key) || [];

        existing.push({
            value,
            labels,
            timestamp: Date.now(),
        });

        this.gauges.set(key, existing);
    }

    /**
     * Record a histogram observation
     */
    observeHistogram(name: string, value: number, labels: Record<string, string> = {}) {
        const key = this.getKey(name, labels);
        const existing = this.histograms.get(key) || [];

        existing.push({
            value,
            labels,
            timestamp: Date.now(),
        });

        this.histograms.set(key, existing);
    }

    /**
     * Get all metrics in Prometheus text format
     */
    getMetrics(): string {
        const lines: string[] = [];

        // Counters
        for (const [key, values] of this.counters.entries()) {
            const latest = values[values.length - 1];
            const labelStr = this.formatLabels(latest.labels);
            lines.push(`${key}${labelStr} ${latest.value}`);
        }

        // Gauges
        for (const [key, values] of this.gauges.entries()) {
            const latest = values[values.length - 1];
            const labelStr = this.formatLabels(latest.labels);
            lines.push(`${key}${labelStr} ${latest.value}`);
        }

        // Histograms (simplified - just average for now)
        for (const [key, values] of this.histograms.entries()) {
            const sum = values.reduce((acc, v) => acc + v.value, 0);
            const count = values.length;
            const avg = sum / count;
            const latest = values[values.length - 1];
            const labelStr = this.formatLabels(latest.labels);
            lines.push(`${key}_sum${labelStr} ${sum.toFixed(2)}`);
            lines.push(`${key}_count${labelStr} ${count}`);
            lines.push(`${key}_avg${labelStr} ${avg.toFixed(2)}`);
        }

        return lines.join('\n');
    }

    /**
     * Get metrics as JSON
     */
    getMetricsJSON() {
        return {
            counters: Array.from(this.counters.entries()).map(([name, values]) => ({
                name,
                value: values[values.length - 1].value,
                labels: values[values.length - 1].labels,
            })),
            gauges: Array.from(this.gauges.entries()).map(([name, values]) => ({
                name,
                value: values[values.length - 1].value,
                labels: values[values.length - 1].labels,
            })),
            histograms: Array.from(this.histograms.entries()).map(([name, values]) => {
                const sum = values.reduce((acc, v) => acc + v.value, 0);
                const count = values.length;
                return {
                    name,
                    sum,
                    count,
                    avg: sum / count,
                    labels: values[values.length - 1].labels,
                };
            }),
        };
    }

    private getKey(name: string, labels: Record<string, string>): string {
        const labelKeys = Object.keys(labels).sort();
        if (labelKeys.length === 0) return name;

        const labelParts = labelKeys.map((key) => `${key}="${labels[key]}"`);
        return `${name}{${labelParts.join(',')}}`;
    }

    private formatLabels(labels: Record<string, string>): string {
        const keys = Object.keys(labels).sort();
        if (keys.length === 0) return '';

        const parts = keys.map((key) => `${key}="${labels[key]}"`);
        return `{${parts.join(',')}}`;
    }

    reset() {
        this.counters.clear();
        this.gauges.clear();
        this.histograms.clear();
    }
}

// Global metrics instance
export const metrics = new MetricsCollector();

// Helper functions
export function incrementSyncCounter(direction: string, status: string) {
    metrics.incrementCounter('sync_operations_total', { direction, status });
}

export function observeSyncLatency(direction: string, latencyMs: number) {
    metrics.observeHistogram('sync_latency_seconds', latencyMs / 1000, { direction });
}

export function incrementConflictsCounter(strategy: string) {
    metrics.incrementCounter('conflicts_detected_total', { strategy });
}

export function incrementAPICounter(service: string, status: string) {
    metrics.incrementCounter('api_requests_total', { service, status });
}

export function setQueueDepth(queueName: string, depth: number) {
    metrics.setGauge('queue_depth', depth, { queue: queueName });
}

export function setCircuitBreakerState(service: string, state: number) {
    metrics.setGauge('circuit_breaker_state', state, { service });
}

export default metrics;
