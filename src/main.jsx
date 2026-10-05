import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_BASE = "/api/v1";
const GRAFANA_BLOG_FEED_URL = "/grafana-blog-rss/blog/news.xml";

const DASHBOARDS = [
  {
    id: "dku-cloud-nodes",
    name: "DKU Cloud Nodes",
    tag: "linux",
    enabled: true,
  },
  {
    id: "node-exporter-server-metrics",
    name: "Node Exporter Server Metrics",
    tag: "prometheus",
    enabled: false,
  },
  {
    id: "node-exporter-server-metrics-v2",
    name: "Node Exporter Server Metrics v2",
    tag: "IB",
    enabled: false,
  },
];

const INSTANCE_META = {
  "10.0.11.3:9100": { name: "controller-01", role: "Controller", os: "Linux" },
  "10.0.11.16:9100": { name: "compute-01", role: "Compute", os: "Linux" },
  "10.0.11.21:9100": { name: "storage-01", role: "Storage", os: "Linux" },
  "10.0.11.22:9100": { name: "network-01", role: "Network", os: "Linux" },
};

const PROMQL = {
  up: 'up{job="node-exporter"}',
  cpu: '100 - (avg by(instance) (rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[1m])) * 100)',
  mem: '(1 - (node_memory_MemAvailable_bytes{job="node-exporter"} / node_memory_MemTotal_bytes{job="node-exporter"})) * 100',
  disk: '100 - ((node_filesystem_avail_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs|devtmpfs"} / node_filesystem_size_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs|devtmpfs"}) * 100)',
  inode:
    '100 - ((node_filesystem_files_free{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs|devtmpfs"} / node_filesystem_files{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs|devtmpfs"}) * 100)',
  tx: 'sum by(instance) (rate(node_network_transmit_bytes_total{job="node-exporter",device!~"lo|veth.*|docker.*|br.*|flannel.*|cali.*"}[1m]))',
  rx: 'sum by(instance) (rate(node_network_receive_bytes_total{job="node-exporter",device!~"lo|veth.*|docker.*|br.*|flannel.*|cali.*"}[1m]))',
  load1: 'node_load1{job="node-exporter"}',
  cores:
    'count by(instance) (node_cpu_seconds_total{job="node-exporter",mode="idle"})',
  diskIo:
    'max by(instance) (rate(node_disk_io_time_seconds_total{job="node-exporter",device!~"loop.*|ram.*"}[1m]) * 100)',
  httpSuccess: 'probe_success{job="blackbox-http"}',
  httpRtt: 'probe_duration_seconds{job="blackbox-http"} * 1000',
  tcpSuccess: 'probe_success{job="blackbox-tcp"}',
  tcpRtt: 'probe_duration_seconds{job="blackbox-tcp"} * 1000',
};

const RANGE_OPTIONS = [
  { label: "Last 15 minutes", value: 15 },
  { label: "Last 1 hour", value: 60 },
  { label: "Last 3 hours", value: 180 },
  { label: "Last 5 hours", value: 300 },
  { label: "Last 12 hours", value: 720 },
  { label: "Last 24 hours", value: 1440 },
];

const END_OPTIONS = [
  { label: "Now", value: 0 },
  { label: "1 hour ago", value: 60 },
  { label: "3 hours ago", value: 180 },
  { label: "5 hours ago", value: 300 },
  { label: "12 hours ago", value: 720 },
];

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function num(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n;
}

function round(value, digits = 1) {
  const unit = 10 ** digits;
  return Math.round(num(value) * unit) / unit;
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function bytesToMB(value) {
  return value / 1024 / 1024;
}

function formatTime(seconds) {
  return new Date(seconds * 1000).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateTime(seconds) {
  return new Date(seconds * 1000).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatRangeText(minutes, offset) {
  if (offset === 0) {
    if (minutes < 60) return `Last ${minutes} minutes`;
    if (minutes % 60 === 0) return `Last ${minutes / 60} hours`;
  }
  return `${offset + minutes} minutes ago to ${offset} minutes ago`;
}

function resultToMap(result, label = "instance") {
  const map = new Map();
  result.forEach((item) => {
    const key = item.metric?.[label];
    if (key) map.set(key, num(item.value?.[1]));
  });
  return map;
}

function normalizeTarget(target) {
  if (!target) return "";
  return target
    .replace(/^http:\/\//, "")
    .replace(/^https:\/\//, "")
    .replace(/\/metrics$/, "");
}

function blackboxToMap(result) {
  const map = new Map();
  result.forEach((item) => {
    const instance = normalizeTarget(item.metric?.target);
    if (instance) map.set(instance, num(item.value?.[1]));
  });
  return map;
}

async function promQuery(query) {
  const res = await fetch(
    `${API_BASE}/query?query=${encodeURIComponent(query)}`,
  );
  if (!res.ok) throw new Error(`Prometheus query failed: ${res.status}`);
  const json = await res.json();
  if (json.status !== "success")
    throw new Error("Prometheus returned non-success status");
  return json.data.result || [];
}

async function promRangeQuery(query, minutes, offset) {
  const now = Math.floor(Date.now() / 1000);
  const end = now - offset * 60;
  const start = end - minutes * 60;
  let step = 15;
  if (minutes > 15) step = 30;
  if (minutes > 60) step = 60;
  if (minutes > 180) step = 120;
  if (minutes > 720) step = 300;

  const url = `${API_BASE}/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&step=${step}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Prometheus range query failed: ${res.status}`);
  const json = await res.json();
  if (json.status !== "success")
    throw new Error("Prometheus returned non-success status");
  return json.data.result?.[0]?.values || [];
}

async function fetchHosts() {
  const [
    upResult,
    cpuResult,
    memResult,
    diskResult,
    inodeResult,
    txResult,
    rxResult,
    loadResult,
    coresResult,
    diskIoResult,
    httpSuccessResult,
    httpRttResult,
    tcpSuccessResult,
    tcpRttResult,
  ] = await Promise.all([
    promQuery(PROMQL.up),
    promQuery(PROMQL.cpu),
    promQuery(PROMQL.mem),
    promQuery(PROMQL.disk),
    promQuery(PROMQL.inode),
    promQuery(PROMQL.tx),
    promQuery(PROMQL.rx),
    promQuery(PROMQL.load1),
    promQuery(PROMQL.cores),
    promQuery(PROMQL.diskIo),
    promQuery(PROMQL.httpSuccess),
    promQuery(PROMQL.httpRtt),
    promQuery(PROMQL.tcpSuccess),
    promQuery(PROMQL.tcpRtt),
  ]);

  const up = resultToMap(upResult);
  const cpu = resultToMap(cpuResult);
  const mem = resultToMap(memResult);
  const disk = resultToMap(diskResult);
  const inode = resultToMap(inodeResult);
  const tx = resultToMap(txResult);
  const rx = resultToMap(rxResult);
  const load = resultToMap(loadResult);
  const cores = resultToMap(coresResult);
  const diskIo = resultToMap(diskIoResult);
  const httpSuccess = blackboxToMap(httpSuccessResult);
  const httpRtt = blackboxToMap(httpRttResult);
  const tcpSuccess = blackboxToMap(tcpSuccessResult);
  const tcpRtt = blackboxToMap(tcpRttResult);

  return [...up.keys()]
    .filter((instance) => instance !== "localhost:9090")
    .sort()
    .map((instance, index) => {
      const meta = INSTANCE_META[instance] || {
        name: instance.replace(":9100", ""),
        role: "Server",
        os: "Linux",
      };
      const ip = instance.replace(":9100", "");
      const coreCount = Math.max(1, Math.round(cores.get(instance) || 1));
      const loadValue = round(load.get(instance) || 0, 2);
      const host = {
        id: instance,
        instance,
        ip,
        name: meta.name,
        role: meta.role,
        os: meta.os,
        up: up.get(instance) === 1,
        cpu: round(cpu.get(instance) || 0, 1),
        mem: round(mem.get(instance) || 0, 1),
        disk: round(disk.get(instance) || 0, 1),
        inode: round(inode.get(instance) || 0, 1),
        tx: round(bytesToMB(tx.get(instance) || 0), 2),
        rx: round(bytesToMB(rx.get(instance) || 0), 2),
        load: loadValue,
        cores: coreCount,
        loadPercent: round((loadValue / coreCount) * 100, 1),
        diskIo: round(diskIo.get(instance) || 0, 1),
        httpSuccess: httpSuccess.get(instance) === 1,
        tcpSuccess: tcpSuccess.get(instance) === 1,
        rtt: round(httpRtt.get(instance) || 0, 2),
        tcpRtt: round(tcpRtt.get(instance) || 0, 2),
      };
      host.status = getStatus(host);
      host.issue = getIssue(host);
      return host;
    });
}

function getStatus(host) {
  const network = Math.max(host.tx, host.rx);
  if (
    !host.up ||
    !host.httpSuccess ||
    !host.tcpSuccess ||
    host.cpu >= 90 ||
    host.mem >= 90 ||
    host.disk >= 90 ||
    host.inode >= 90 ||
    host.diskIo >= 90 ||
    network >= 10 ||
    host.loadPercent >= 100 ||
    host.rtt >= 500
  ) {
    return "critical";
  }

  if (
    host.cpu >= 70 ||
    host.mem >= 80 ||
    host.disk >= 80 ||
    host.inode >= 80 ||
    host.diskIo >= 70 ||
    network >= 5 ||
    host.loadPercent >= 70 ||
    host.rtt >= 200
  ) {
    return "warning";
  }

  return "normal";
}

function getIssue(host) {
  const network = Math.max(host.tx, host.rx);
  if (!host.up) return "Target Down";
  if (!host.httpSuccess) return "HTTP Probe Failed";
  if (!host.tcpSuccess) return "TCP Probe Failed";
  if (host.cpu >= 70) return "High CPU";
  if (host.mem >= 80) return "High Memory";
  if (host.disk >= 80) return "High Root FS";
  if (host.inode >= 80) return "High Inode";
  if (host.diskIo >= 70) return "Disk I/O Busy";
  if (network >= 5) return "High Network";
  if (host.loadPercent >= 70) return "High Load";
  if (host.rtt >= 200) return "HTTP RTT Delay";
  return "Healthy";
}

function statusText(status) {
  if (status === "critical") return "Critical";
  if (status === "warning") return "Warning";
  return "Healthy";
}

function statusRank(status) {
  if (status === "critical") return 3;
  if (status === "warning") return 2;
  return 1;
}

function riskValue(host) {
  if (!host) return 0;
  if (!host.up || !host.httpSuccess || !host.tcpSuccess) return 100;
  return Math.round(
    host.cpu * 0.2 +
      host.mem * 0.18 +
      Math.max(host.disk, host.inode) * 0.18 +
      host.diskIo * 0.12 +
      clamp(Math.max(host.tx, host.rx) * 10) * 0.12 +
      host.loadPercent * 0.1 +
      clamp(host.rtt / 5) * 0.1,
  );
}

function buildTargetUrl(host) {
  return `http://${host.ip}:9100/metrics`;
}

function rangePromqlFor(host, type) {
  const instance = host.instance;
  if (type === "cpu")
    return `100 - (avg by(instance) (rate(node_cpu_seconds_total{job="node-exporter",instance="${instance}",mode="idle"}[1m])) * 100)`;
  if (type === "mem")
    return `(1 - (node_memory_MemAvailable_bytes{job="node-exporter",instance="${instance}"} / node_memory_MemTotal_bytes{job="node-exporter",instance="${instance}"})) * 100`;
  if (type === "disk")
    return `100 - ((node_filesystem_avail_bytes{job="node-exporter",instance="${instance}",mountpoint="/",fstype!~"tmpfs|overlay|squashfs|devtmpfs"} / node_filesystem_size_bytes{job="node-exporter",instance="${instance}",mountpoint="/",fstype!~"tmpfs|overlay|squashfs|devtmpfs"}) * 100)`;
  if (type === "inode")
    return `100 - ((node_filesystem_files_free{job="node-exporter",instance="${instance}",mountpoint="/",fstype!~"tmpfs|overlay|squashfs|devtmpfs"} / node_filesystem_files{job="node-exporter",instance="${instance}",mountpoint="/",fstype!~"tmpfs|overlay|squashfs|devtmpfs"}) * 100)`;
  if (type === "diskIo")
    return `max by(instance) (rate(node_disk_io_time_seconds_total{job="node-exporter",instance="${instance}",device!~"loop.*|ram.*"}[1m]) * 100)`;
  if (type === "net")
    return `sum by(instance) (rate(node_network_receive_bytes_total{job="node-exporter",instance="${instance}",device!~"lo|veth.*|docker.*|br.*|flannel.*|cali.*"}[1m]) + rate(node_network_transmit_bytes_total{job="node-exporter",instance="${instance}",device!~"lo|veth.*|docker.*|br.*|flannel.*|cali.*"}[1m])) / 1024 / 1024`;
  if (type === "rtt")
    return `probe_duration_seconds{job="blackbox-http",target="${buildTargetUrl(host)}"} * 1000`;
  return "";
}

function toPoint(item) {
  const timestamp = Number(item[0]);
  return {
    timestamp,
    time: formatTime(timestamp),
    datetime: formatDateTime(timestamp),
    value: round(item[1], 2),
  };
}

function getSeriesLength(series) {
  return Math.max(
    series.cpu.length,
    series.mem.length,
    series.disk.length,
    series.inode.length,
    series.diskIo.length,
    series.net.length,
    series.rtt.length,
  );
}

function getSeriesAt(series, index) {
  return {
    datetime:
      series.cpu[index]?.datetime ||
      series.mem[index]?.datetime ||
      series.disk[index]?.datetime ||
      series.net[index]?.datetime ||
      series.rtt[index]?.datetime ||
      "-",
    cpu: series.cpu[index]?.value ?? 0,
    mem: series.mem[index]?.value ?? 0,
    disk: series.disk[index]?.value ?? 0,
    inode: series.inode[index]?.value ?? 0,
    diskIo: series.diskIo[index]?.value ?? 0,
    net: series.net[index]?.value ?? 0,
    rtt: series.rtt[index]?.value ?? 0,
  };
}

function buildMetricLogs(series) {
  const rows = [];
  for (let i = 0; i < getSeriesLength(series); i += 1)
    rows.push(getSeriesAt(series, i));
  return rows.reverse();
}

function buildIssueTimeline(series) {
  const rows = [];
  for (let i = 0; i < getSeriesLength(series); i += 1) {
    const row = getSeriesAt(series, i);
    if (row.cpu >= 70)
      rows.push({
        datetime: row.datetime,
        metric: "CPU",
        value: `${row.cpu}%`,
        threshold: ">= 70%",
      });
    if (row.mem >= 80)
      rows.push({
        datetime: row.datetime,
        metric: "Memory",
        value: `${row.mem}%`,
        threshold: ">= 80%",
      });
    if (row.disk >= 80)
      rows.push({
        datetime: row.datetime,
        metric: "Root FS",
        value: `${row.disk}%`,
        threshold: ">= 80%",
      });
    if (row.inode >= 80)
      rows.push({
        datetime: row.datetime,
        metric: "Inode",
        value: `${row.inode}%`,
        threshold: ">= 80%",
      });
    if (row.diskIo >= 70)
      rows.push({
        datetime: row.datetime,
        metric: "Disk I/O",
        value: `${row.diskIo}%`,
        threshold: ">= 70%",
      });
    if (row.net >= 5)
      rows.push({
        datetime: row.datetime,
        metric: "Network",
        value: `${row.net} MB/s`,
        threshold: ">= 5 MB/s",
      });
    if (row.rtt >= 200)
      rows.push({
        datetime: row.datetime,
        metric: "HTTP RTT",
        value: `${row.rtt} ms`,
        threshold: ">= 200 ms",
      });
  }
  return rows.reverse();
}

function buildActiveIssues(hosts) {
  const rows = [];
  hosts.forEach((host) => {
    const base = {
      host: host.name,
      ip: host.ip,
      status: host.status,
      severity: statusText(host.status),
      priority: riskValue(host),
    };

    if (!host.up)
      rows.push({
        ...base,
        metric: "Target",
        value: "down",
        threshold: "up == 1",
      });
    if (!host.httpSuccess)
      rows.push({
        ...base,
        metric: "HTTP Probe",
        value: "failed",
        threshold: "success == 1",
      });
    if (!host.tcpSuccess)
      rows.push({
        ...base,
        metric: "TCP Probe",
        value: "failed",
        threshold: "success == 1",
      });
    if (host.cpu >= 70)
      rows.push({
        ...base,
        metric: "CPU",
        value: `${host.cpu}%`,
        threshold: ">= 70%",
      });
    if (host.mem >= 80)
      rows.push({
        ...base,
        metric: "Memory",
        value: `${host.mem}%`,
        threshold: ">= 80%",
      });
    if (host.disk >= 80)
      rows.push({
        ...base,
        metric: "Root FS",
        value: `${host.disk}%`,
        threshold: ">= 80%",
      });
    if (host.inode >= 80)
      rows.push({
        ...base,
        metric: "Inode",
        value: `${host.inode}%`,
        threshold: ">= 80%",
      });
    if (host.diskIo >= 70)
      rows.push({
        ...base,
        metric: "Disk I/O",
        value: `${host.diskIo}%`,
        threshold: ">= 70%",
      });
    if (Math.max(host.tx, host.rx) >= 5)
      rows.push({
        ...base,
        metric: "Network",
        value: `${Math.max(host.tx, host.rx)} MB/s`,
        threshold: ">= 5 MB/s",
      });
    if (host.loadPercent >= 70)
      rows.push({
        ...base,
        metric: "Load",
        value: `${host.loadPercent}%/core`,
        threshold: ">= 70%/core",
      });
    if (host.rtt >= 200)
      rows.push({
        ...base,
        metric: "HTTP RTT",
        value: `${host.rtt} ms`,
        threshold: ">= 200 ms",
      });
  });
  return rows.sort((a, b) => b.priority - a.priority);
}

const EVENT_TIMELINE_KEY = "dku_cloud_event_timeline_v1";
const EVENT_STATUS_KEY = "dku_cloud_event_status_v1";

function readStorageJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStorageJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage를 사용할 수 없는 환경이면 화면만 갱신한다.
  }
}

function issueMetricValue(host) {
  if (!host.up) return "down";
  if (!host.httpSuccess) return "failed";
  if (!host.tcpSuccess) return "failed";
  if (host.cpu >= 70) return `${host.cpu}%`;
  if (host.mem >= 80) return `${host.mem}%`;
  if (host.disk >= 80) return `${host.disk}%`;
  if (host.inode >= 80) return `${host.inode}%`;
  if (host.diskIo >= 70) return `${host.diskIo}%`;
  if (Math.max(host.tx, host.rx) >= 5)
    return `${Math.max(host.tx, host.rx)} MB/s`;
  if (host.loadPercent >= 70) return `${host.loadPercent}%/core`;
  if (host.rtt >= 200) return `${host.rtt} ms`;
  return "normal";
}

function updateEventTimeline(hosts) {
  const previousStatus = readStorageJson(EVENT_STATUS_KEY, {});
  const previousEvents = readStorageJson(EVENT_TIMELINE_KEY, []);
  const nextStatus = {};
  const createdEvents = [];
  const now = Math.floor(Date.now() / 1000);

  hosts.forEach((host) => {
    const current = {
      status: host.status,
      issue: host.issue,
    };

    const prev = previousStatus[host.id];
    nextStatus[host.id] = current;

    if (!prev) {
      if (host.status !== "normal") {
        createdEvents.push({
          id: `${host.id}-${now}-initial`,
          time: formatDateTime(now),
          type: "DETECTED",
          status: host.status,
          host: host.name,
          ip: host.ip,
          issue: host.issue,
          value: issueMetricValue(host),
          message: `${host.issue} detected`,
        });
      }
      return;
    }

    if (prev.status === host.status && prev.issue === host.issue) return;

    const recovered = host.status === "normal";

    createdEvents.push({
      id: `${host.id}-${now}-${host.status}-${host.issue}`,
      time: formatDateTime(now),
      type: recovered ? "RECOVERY" : "DETECTED",
      status: host.status,
      host: host.name,
      ip: host.ip,
      issue: recovered ? prev.issue : host.issue,
      value: issueMetricValue(host),
      message: recovered ? `${prev.issue} recovered` : `${host.issue} detected`,
    });
  });

  writeStorageJson(EVENT_STATUS_KEY, nextStatus);

  const merged = [...createdEvents, ...previousEvents].slice(0, 80);
  writeStorageJson(EVENT_TIMELINE_KEY, merged);
  return merged;
}

function normalizeGrafanaUrl(url) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://grafana.com${url}`;
  return url;
}

function stripHtml(value) {
  if (!value) return "";
  const doc = new DOMParser().parseFromString(value, "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

function extractFirstImage(...htmlValues) {
  for (const html of htmlValues) {
    if (!html) continue;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const img = doc.querySelector("img");
    const src = img?.getAttribute("src") || img?.getAttribute("data-src");
    if (src) return normalizeGrafanaUrl(src);
  }
  return "";
}

function formatBlogDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("ko-KR", {
    month: "long",
    day: "2-digit",
  });
}

function xmlText(parent, tagName) {
  return parent.getElementsByTagName(tagName)?.[0]?.textContent?.trim() || "";
}

async function fetchGrafanaBlogPosts() {
  const res = await fetch(GRAFANA_BLOG_FEED_URL, { cache: "no-store" });

  if (!res.ok) {
    throw new Error(`Grafana blog RSS failed: ${res.status}`);
  }

  const xmlTextValue = await res.text();
  const xml = new DOMParser().parseFromString(xmlTextValue, "application/xml");

  if (xml.querySelector("parsererror")) {
    throw new Error("Grafana blog RSS parse failed");
  }

  return Array.from(xml.querySelectorAll("item"))
    .slice(0, 5)
    .map((item, index) => {
      const title = xmlText(item, "title");
      const link = normalizeGrafanaUrl(xmlText(item, "link"));
      const pubDate = xmlText(item, "pubDate");
      const descriptionHtml = xmlText(item, "description");
      const contentHtml = xmlText(item, "content:encoded");
      const media = item.getElementsByTagName("media:content")?.[0];
      const enclosure = item.getElementsByTagName("enclosure")?.[0];
      const image = normalizeGrafanaUrl(
        media?.getAttribute("url") ||
          enclosure?.getAttribute("url") ||
          extractFirstImage(contentHtml, descriptionHtml),
      );

      return {
        id: `${link || title}-${index}`,
        title,
        link,
        date: formatBlogDate(pubDate),
        summary: stripHtml(descriptionHtml || contentHtml),
        image,
      };
    })
    .filter((post) => post.title);
}

function App() {
  const [page, setPage] = useState("home");
  const [hosts, setHosts] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [dashboardSearch, setDashboardSearch] = useState("");
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState("-");
  const [timeRange, setTimeRange] = useState(300);
  const [endOffset, setEndOffset] = useState(0);
  const [refreshSec, setRefreshSec] = useState(5);
  const [eventTimeline, setEventTimeline] = useState(() =>
    readStorageJson(EVENT_TIMELINE_KEY, []),
  );

  async function refresh() {
    try {
      setError("");
      const next = await fetchHosts();
      setHosts(next);
      setEventTimeline(updateEventTimeline(next));
      setLastUpdated(
        new Date().toLocaleTimeString("ko-KR", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );

      if (!selectedId && next.length) {
        const first = [...next].sort((a, b) => {
          const statusDiff = statusRank(b.status) - statusRank(a.status);
          if (statusDiff !== 0) return statusDiff;
          return riskValue(b) - riskValue(a);
        })[0];
        setSelectedId(first.id);
      }
    } catch (e) {
      setError(e.message || "Prometheus API 연결 실패");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(refresh, refreshSec * 1000);
    return () => window.clearInterval(timer);
  }, [refreshSec, selectedId]);

  const selectedHost = hosts.find((h) => h.id === selectedId) || hosts[0];

  function openDashboard(id) {
    if (id === "dku-cloud-nodes") setPage("nodes");
  }

  function openHost(host) {
    setSelectedId(host.id);
    setPage("node-detail");
  }

  return (
    <div className="grafana-app">
      <SideNav page={page} setPage={setPage} />
      <section className="workspace">
        <TopNav
          page={page}
          setPage={setPage}
          selectedHost={selectedHost}
          search={search}
          setSearch={setSearch}
          lastUpdated={lastUpdated}
          refresh={refresh}
        />
        {error && (
          <div className="error-banner">Prometheus 연결 오류: {error}</div>
        )}

        {page === "home" && <HomePage openDashboard={openDashboard} />}
        {page === "dashboards" && (
          <DashboardsPage
            search={dashboardSearch}
            setSearch={setDashboardSearch}
            openDashboard={openDashboard}
          />
        )}
        {page === "nodes" && (
          <DkuCloudNodes
            hosts={hosts}
            globalSearch={search}
            openHost={openHost}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
            endOffset={endOffset}
            setEndOffset={setEndOffset}
            refreshSec={refreshSec}
            setRefreshSec={setRefreshSec}
            eventTimeline={eventTimeline}
          />
        )}
        {page === "node-detail" && (
          <NodeDetailPage
            selectedHost={selectedHost}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
            endOffset={endOffset}
            setEndOffset={setEndOffset}
            onBack={() => setPage("nodes")}
          />
        )}
      </section>
    </div>
  );
}

function SideNav({ page, setPage }) {
  return (
    <aside className="side-nav">
      <div className="side-logo">DKU</div>
      <button
        className={page === "home" ? "active" : ""}
        onClick={() => setPage("home")}
        title="Home"
      >
        ⌂
      </button>
      <button title="Bookmarks">▱</button>
      <button title="Starred">☆</button>
      <button
        className={page === "dashboards" ? "active" : ""}
        onClick={() => setPage("dashboards")}
        title="Dashboards"
      >
        ▦
      </button>
      <button title="Alerting">△</button>
    </aside>
  );
}

function TopNav({
  page,
  setPage,
  selectedHost,
  search,
  setSearch,
  lastUpdated,
  refresh,
}) {
  return (
    <header className="grafana-top">
      <nav className="crumb breadcrumb-nav">
        <button onClick={() => setPage("home")}>Home</button>

        {(page === "dashboards" ||
          page === "nodes" ||
          page === "node-detail") && (
          <>
            <span>›</span>
            <button onClick={() => setPage("dashboards")}>Dashboards</button>
          </>
        )}

        {(page === "nodes" || page === "node-detail") && (
          <>
            <span>›</span>
            <button onClick={() => setPage("nodes")}>DKU Cloud Nodes</button>
          </>
        )}

        {page === "node-detail" && (
          <>
            <span>›</span>
            <strong>{selectedHost?.name || "Node Detail"}</strong>
          </>
        )}
      </nav>

      <div className="top-search">
        <span>⌕</span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search or jump to..."
        />
      </div>
      <div className="top-icons">
        <span>{lastUpdated}</span>
        <button onClick={refresh}>↻</button>
        <span>?</span>
        <span>◉</span>
      </div>
    </header>
  );
}

function HomePage({ openDashboard }) {
  const [blogPosts, setBlogPosts] = useState([]);
  const [blogLoading, setBlogLoading] = useState(true);
  const [blogError, setBlogError] = useState("");

  useEffect(() => {
    let alive = true;

    async function loadBlog() {
      try {
        setBlogLoading(true);
        setBlogError("");
        const posts = await fetchGrafanaBlogPosts();
        if (alive) setBlogPosts(posts);
      } catch (e) {
        if (alive) setBlogError(e.message || "Grafana blog RSS load failed");
      } finally {
        if (alive) setBlogLoading(false);
      }
    }

    loadBlog();

    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="home-page">
      <section className="welcome-panel">
        <h1>Welcome to DKU Cloud Dashboard</h1>
        <div className="help-links">
          <b>Need help?</b>
          <span>Documentation</span>
          <span>Tutorials</span>
          <span>Community</span>
          <span>Public Slack</span>
        </div>
      </section>

      <section className="home-grid">
        <div className="home-card">
          <div className="card-menu">⋮</div>
          <h3>Dashboards</h3>
          <h4>Starred dashboards</h4>
          <div className="blank-space" />
          <h4>Recently viewed dashboards</h4>
        </div>

        <div className="home-card blog-card">
          <h3>Latest from the blog</h3>

          {blogLoading && (
            <div className="blog-state">Loading Grafana blog RSS...</div>
          )}

          {!blogLoading && blogError && (
            <div className="blog-state error">
              Grafana blog RSS를 불러오지 못했습니다. Vite proxy의
              /grafana-blog-rss 설정을 확인하세요.
            </div>
          )}

          {!blogLoading && !blogError && blogPosts.length === 0 && (
            <div className="blog-state">No blog posts returned from RSS.</div>
          )}

          {!blogLoading &&
            !blogError &&
            blogPosts.map((post) => <BlogItem key={post.id} post={post} />)}
        </div>
      </section>
    </main>
  );
}

function BlogItem({ post }) {
  return (
    <a
      className={`blog-item ${post.image ? "" : "no-image"}`}
      href={post.link || "https://grafana.com/blog/"}
      target="_blank"
      rel="noreferrer"
    >
      {post.image && (
        <div className="blog-thumb">
          <img src={post.image} alt="" loading="lazy" />
        </div>
      )}
      <div>
        <small>{post.date}</small>
        <strong>{post.title}</strong>
        {post.summary && <p>{post.summary}</p>}
      </div>
    </a>
  );
}

function DashboardsPage({ search, setSearch, openDashboard }) {
  const rows = DASHBOARDS.filter((d) =>
    d.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <main className="dashboards-page">
      <h1>Dashboards</h1>
      <p>Create and manage dashboards to visualize your data</p>

      <div className="dashboard-search">
        <span>⌕</span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search for dashboards and folders"
        />
      </div>

      <div className="dashboard-toolbar">
        <button>◇ Filter by tag</button>
        <label>
          <input type="checkbox" /> Starred
        </label>
        <div />
        <button>▣</button>
        <button>☰</button>
        <button>Sort</button>
      </div>

      <div className="dashboard-table">
        <div className="dashboard-head">
          <span>Name</span>
          <span>Tags</span>
        </div>

        <div className="folder-row">⌄ Shared with me</div>

        {rows.map((d) => (
          <button
            className="dashboard-row"
            key={d.id}
            onClick={() => openDashboard(d.id)}
          >
            <span>▦ {d.name}</span>
            <span className={`tag tag-${d.tag.toLowerCase()}`}>{d.tag}</span>
          </button>
        ))}
      </div>
    </main>
  );
}

function DkuCloudNodes({
  hosts,
  globalSearch,
  openHost,
  timeRange,
  setTimeRange,
  endOffset,
  setEndOffset,
  refreshSec,
  setRefreshSec,
  eventTimeline,
}) {
  const q = globalSearch.trim().toLowerCase();

  const filtered = hosts.filter((h) => {
    if (!q) return true;
    return (
      h.name.toLowerCase().includes(q) ||
      h.ip.includes(q) ||
      h.role.toLowerCase().includes(q) ||
      h.status.toLowerCase().includes(q) ||
      h.issue.toLowerCase().includes(q)
    );
  });

  const sortedHosts = [...filtered].sort((a, b) => {
    const statusDiff = statusRank(b.status) - statusRank(a.status);
    if (statusDiff !== 0) return statusDiff;
    return riskValue(b) - riskValue(a);
  });

  const issues = buildActiveIssues(hosts).slice(0, 10);
  const critical = hosts.filter((h) => h.status === "critical").length;
  const warning = hosts.filter((h) => h.status === "warning").length;
  const healthy = hosts.filter((h) => h.status === "normal").length;
  const worst = sortedHosts[0];
  const maxCpu = getWorstHost(hosts, "cpu");
  const maxMem = getWorstHost(hosts, "mem");
  const maxDisk = getWorstHost(hosts, "disk");
  const maxLoad = getWorstHost(hosts, "loadPercent");
  const maxRtt = getWorstHost(hosts, "rtt");
  const maxNet = getWorstHost(hosts, (h) => Math.max(h.rx, h.tx));
  const maxDiskIo = getWorstHost(hosts, "diskIo");

  return (
    <main className="nodes-page evolved">
      <DashboardHeader
        title="DKU Cloud Nodes"
        subtitle="node-exporter · blackbox-exporter · prometheus"
      />

      <div className="grafana-controls-row">
        <Select
          label="Datasource"
          value="prometheus"
          onChange={() => {}}
          options={[{ label: "prometheus", value: "prometheus" }]}
        />
        <Select
          label="Job"
          value="node-exporter"
          onChange={() => {}}
          options={[{ label: "node-exporter", value: "node-exporter" }]}
        />
        <div className="control-fill" />
        <Controls
          timeRange={timeRange}
          setTimeRange={setTimeRange}
          endOffset={endOffset}
          setEndOffset={setEndOffset}
          refreshSec={refreshSec}
          setRefreshSec={setRefreshSec}
        />
      </div>

      <section className="fleet-strip">
        <Stat title="Total Nodes" value={hosts.length} />
        <Stat title="Healthy" value={healthy} tone="green" />
        <Stat title="Warning" value={warning} tone="yellow" />
        <Stat title="Critical" value={critical} tone="red" />
        <Stat
          title="Avg CPU"
          value={`${round(avg(hosts.map((h) => h.cpu)), 1)}%`}
        />
        <Stat
          title="Avg Memory"
          value={`${round(avg(hosts.map((h) => h.mem)), 1)}%`}
        />
        <Stat
          title="Avg Disk"
          value={`${round(avg(hosts.map((h) => h.disk)), 1)}%`}
        />
      </section>

      <section className="nodes-grid evolved-grid">
        <Panel title="Node Health Overview">
          <NodeTable hosts={sortedHosts.slice(0, 10)} onSelect={openHost} />
        </Panel>

        <Panel title="Active Issues">
          <IssueTable issues={issues} hosts={hosts} onSelect={openHost} />
        </Panel>
      </section>

      <section className="event-timeline-panel">
        <Panel title="Recent Event Timeline">
          <RecentEventTimeline
            events={eventTimeline}
            hosts={hosts}
            onSelect={openHost}
          />
        </Panel>
      </section>
    </main>
  );
}

function getWorstHost(hosts, keyOrGetter) {
  if (!hosts.length) return { host: null, value: 0 };
  const getter =
    typeof keyOrGetter === "function"
      ? keyOrGetter
      : (host) => host[keyOrGetter];
  const host = [...hosts].sort((a, b) => num(getter(b)) - num(getter(a)))[0];
  return { host, value: round(getter(host), 2) };
}

function thresholdTone(value, warning, critical) {
  if (value >= critical) return "critical";
  if (value >= warning) return "warning";
  return "normal";
}

function PressurePanel({ hosts, healthy, warning, critical }) {
  const total = hosts.length;
  const up = hosts.filter((h) => h.up).length;
  const httpOk = hosts.filter((h) => h.httpSuccess).length;
  const tcpOk = hosts.filter((h) => h.tcpSuccess).length;

  return (
    <section className="pressure-panel">
      <div className="mini-title">Pressure</div>
      <div className="pressure-line">
        <span>Targets</span>
        <b>
          {up}/{total}
        </b>
      </div>
      <PressureBar label="CPU" value={round(avg(hosts.map((h) => h.cpu)), 1)} />
      <PressureBar label="Mem" value={round(avg(hosts.map((h) => h.mem)), 1)} />
      <PressureBar
        label="I/O"
        value={round(avg(hosts.map((h) => h.diskIo)), 1)}
      />
      <div className="pressure-status">
        <span className="green">{healthy}</span>
        <span className="yellow">{warning}</span>
        <span className="red">{critical}</span>
      </div>
      <small>
        HTTP {httpOk}/{total} · TCP {tcpOk}/{total}
      </small>
    </section>
  );
}

function PressureBar({ label, value }) {
  return (
    <div className="pressure-bar-row">
      <span>{label}</span>
      <div className="pressure-bar">
        <i style={{ width: `${clamp(value)}%` }} />
      </div>
      <b>{value}%</b>
    </div>
  );
}

function GaugeCard({ title, host, value, unit, warning, critical, onClick }) {
  const tone = thresholdTone(value, warning, critical);
  const degree = (clamp(value, 0, critical) / critical) * 270;

  return (
    <button
      className={`gauge-card ${tone}`}
      onClick={() => host && onClick(host)}
    >
      <div className="mini-title">{title}</div>
      <div className="gauge" style={{ "--deg": `${degree}deg` }}>
        <div className="gauge-inner">
          <strong>
            {value === null || value === undefined ? "N/A" : round(value, 1)}
          </strong>
          <span>{unit}</span>
        </div>
      </div>
      <small>{host ? host.name : "No data"}</small>
    </button>
  );
}

function MiniMetric({ title, host, value, unit, warning, critical, onClick }) {
  const tone = thresholdTone(value, warning, critical);
  return (
    <button
      className={`mini-metric ${tone}`}
      onClick={() => host && onClick(host)}
    >
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{unit}</small>
      <em>{host ? host.name : "No data"}</em>
    </button>
  );
}

function RiskRank({ hosts, onSelect }) {
  return (
    <div className="risk-rank">
      {hosts.map((host, index) => {
        const risk = riskValue(host);
        return (
          <button
            key={host.id}
            className="risk-row"
            onClick={() => onSelect(host)}
          >
            <span>{index + 1}</span>
            <b>{host.name}</b>
            <i>{host.issue}</i>
            <div className="risk-track">
              <div style={{ width: `${clamp(risk)}%` }} />
            </div>
            <strong>{risk}</strong>
          </button>
        );
      })}
      {hosts.length === 0 && <div className="empty-box">No target data</div>}
    </div>
  );
}

function MetricLeaders({ items, onSelect }) {
  return (
    <div className="metric-leaders">
      {items.map((item) => (
        <button
          key={item.label}
          onClick={() => item.data.host && onSelect(item.data.host)}
        >
          <span>{item.label}</span>
          <b>
            {round(item.data.value, item.unit === "MB/s" ? 2 : 1)}
            {item.unit}
          </b>
          <small>{item.data.host ? item.data.host.name : "No data"}</small>
        </button>
      ))}
    </div>
  );
}

function RecentEventTimeline({ events, hosts, onSelect }) {
  return (
    <div className="event-timeline">
      <div className="event-timeline-head">
        <span>Time</span>
        <span>Type</span>
        <span>Host</span>
        <span>IP</span>
        <span>Issue</span>
        <span>Value</span>
        <span>Message</span>
      </div>

      {events.map((event) => {
        const host = hosts.find(
          (h) => h.name === event.host || h.ip === event.ip,
        );

        return (
          <button
            className="event-timeline-row"
            key={event.id}
            onClick={() => host && onSelect(host)}
          >
            <span>{event.time}</span>
            <span
              className={
                event.type === "RECOVERY" ? "event-recovery" : "event-detected"
              }
            >
              {event.type}
            </span>
            <span>{event.host}</span>
            <span>{event.ip}</span>
            <span>{event.issue}</span>
            <span>{event.value}</span>
            <span>{event.message}</span>
          </button>
        );
      })}

      {events.length === 0 && (
        <div className="empty-box">
          No recent events. 상태 변화가 발생하면 이 영역에 DETECTED / RECOVERY
          이력이 기록됩니다.
        </div>
      )}
    </div>
  );
}

function DashboardHeader({ title, subtitle }) {
  return (
    <div className="dashboard-title">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

function Controls({
  timeRange,
  setTimeRange,
  endOffset,
  setEndOffset,
  refreshSec,
  setRefreshSec,
}) {
  return (
    <div className="controls-line">
      <Select
        label="Range"
        value={timeRange}
        onChange={(v) => setTimeRange(Number(v))}
        options={RANGE_OPTIONS}
      />
      <Select
        label="End"
        value={endOffset}
        onChange={(v) => setEndOffset(Number(v))}
        options={END_OPTIONS}
      />
      <Select
        label="Refresh"
        value={refreshSec}
        onChange={(v) => setRefreshSec(Number(v))}
        options={[
          { label: "5s", value: 5 },
          { label: "10s", value: 10 },
          { label: "30s", value: 30 },
          { label: "1m", value: 60 },
        ]}
      />
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="select-box">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Stat({ title, value, tone = "" }) {
  return (
    <div className={`stat ${tone}`}>
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function NodeTable({ hosts, onSelect }) {
  return (
    <div className="node-table">
      <div className="node-head">
        <span>Host</span>
        <span>IP</span>
        <span>Status</span>
        <span>Issue</span>
        <span>CPU</span>
        <span>MEM</span>
        <span>Disk</span>
        <span>RTT</span>
      </div>
      {hosts.map((h) => (
        <button className="node-row" key={h.id} onClick={() => onSelect(h)}>
          <span>
            <i className={`dot ${h.status}`} /> {h.name}
          </span>
          <span>{h.ip}</span>
          <span>{statusText(h.status)}</span>
          <span>{h.issue}</span>
          <span>{h.cpu}%</span>
          <span>{h.mem}%</span>
          <span>{h.disk}%</span>
          <span>{round(h.rtt, 1)}ms</span>
        </button>
      ))}
      {hosts.length === 0 && <div className="empty-box">No target data</div>}
    </div>
  );
}

function IssueTable({ issues, hosts, onSelect }) {
  return (
    <div className="issue-table">
      <div className="issue-head">
        <span>Status</span>
        <span>Host</span>
        <span>Metric</span>
        <span>Value</span>
        <span>Threshold</span>
      </div>
      {issues.map((issue, index) => (
        <button
          key={`${issue.host}-${issue.metric}-${index}`}
          className="issue-row"
          onClick={() => {
            const host = hosts.find((h) => h.name === issue.host);
            if (host) onSelect(host);
          }}
        >
          <span>
            <i className={`dot ${issue.status}`} /> {issue.severity}
          </span>
          <span>{issue.host}</span>
          <span>{issue.metric}</span>
          <span>{issue.value}</span>
          <span>{issue.threshold}</span>
        </button>
      ))}
      {issues.length === 0 && <div className="empty-box">No active issues</div>}
    </div>
  );
}

function NodeDetailPage({
  selectedHost,
  timeRange,
  setTimeRange,
  endOffset,
  setEndOffset,
  onBack,
}) {
  const [series, setSeries] = useState({
    cpu: [],
    mem: [],
    disk: [],
    inode: [],
    diskIo: [],
    net: [],
    rtt: [],
  });
  const [rangeError, setRangeError] = useState("");

  async function loadRange(host) {
    if (!host) return;
    try {
      setRangeError("");
      const [cpu, mem, disk, inode, diskIo, net, rtt] = await Promise.all([
        promRangeQuery(rangePromqlFor(host, "cpu"), timeRange, endOffset),
        promRangeQuery(rangePromqlFor(host, "mem"), timeRange, endOffset),
        promRangeQuery(rangePromqlFor(host, "disk"), timeRange, endOffset),
        promRangeQuery(rangePromqlFor(host, "inode"), timeRange, endOffset),
        promRangeQuery(rangePromqlFor(host, "diskIo"), timeRange, endOffset),
        promRangeQuery(rangePromqlFor(host, "net"), timeRange, endOffset),
        promRangeQuery(rangePromqlFor(host, "rtt"), timeRange, endOffset),
      ]);

      setSeries({
        cpu: cpu.map(toPoint),
        mem: mem.map(toPoint),
        disk: disk.map(toPoint),
        inode: inode.map(toPoint),
        diskIo: diskIo.map(toPoint),
        net: net.map(toPoint),
        rtt: rtt.map(toPoint),
      });
    } catch (e) {
      setRangeError(e.message || "과거 시계열 조회 실패");
    }
  }

  useEffect(() => {
    loadRange(selectedHost);
  }, [selectedHost?.id, timeRange, endOffset]);

  if (!selectedHost) return <main className="empty-page">No target data</main>;

  const metricLogs = buildMetricLogs(series);
  const issueTimeline = buildIssueTimeline(series);

  return (
    <main className="detail-page">
      <div className="detail-title-row">
        <DashboardHeader
          title={selectedHost.name}
          subtitle={`${selectedHost.role} · ${selectedHost.os} · ${selectedHost.ip} · ${formatRangeText(timeRange, endOffset)}`}
        />
        <button className="back-button" onClick={onBack}>
          ← Back to DKU Cloud Nodes
        </button>
      </div>
      <div className="grafana-controls-row detail-controls-row">
        <Select
          label="Datasource"
          value="prometheus"
          onChange={() => {}}
          options={[{ label: "prometheus", value: "prometheus" }]}
        />
        <Select
          label="Job"
          value="node-exporter"
          onChange={() => {}}
          options={[{ label: "node-exporter", value: "node-exporter" }]}
        />
        <div className="control-fill" />
        <Controls
          timeRange={timeRange}
          setTimeRange={setTimeRange}
          endOffset={endOffset}
          setEndOffset={setEndOffset}
          refreshSec={5}
          setRefreshSec={() => {}}
        />
      </div>

      {rangeError && <div className="error-banner inline">{rangeError}</div>}

      <section className="chart-grid">
        <LinePanel
          title="CPU Utilization"
          unit="%"
          data={series.cpu}
          max={100}
          warning={70}
          critical={90}
        />
        <LinePanel
          title="Memory Usage"
          unit="%"
          data={series.mem}
          max={100}
          warning={80}
          critical={90}
        />
        <LinePanel
          title="Root Filesystem Usage"
          unit="%"
          data={series.disk}
          max={100}
          warning={80}
          critical={90}
        />
        <LinePanel
          title="Inode Usage"
          unit="%"
          data={series.inode}
          max={100}
          warning={80}
          critical={90}
        />
        <LinePanel
          title="Disk I/O Busy"
          unit="%"
          data={series.diskIo}
          max={100}
          warning={70}
          critical={90}
        />
        <LinePanel
          title="Network Throughput"
          unit="MB/s"
          data={series.net}
          max={10}
          warning={5}
          critical={10}
        />
        <LinePanel
          title="HTTP Probe Time"
          unit="ms"
          data={series.rtt}
          max={500}
          warning={200}
          critical={500}
        />
      </section>

      <section className="history-grid">
        <Panel title="Issue Timeline">
          <IssueTimeline issues={issueTimeline} />
        </Panel>
        <Panel title="Metric History">
          <MetricHistory logs={metricLogs} />
        </Panel>
      </section>
    </main>
  );
}

function LinePanel({ title, unit, data, max, warning, critical }) {
  const latest = data.length ? data[data.length - 1].value : null;
  return (
    <section className="line-panel">
      <div className="line-head">
        <h3>{title}</h3>
        <span>{latest !== null ? `${latest}${unit}` : "No data"}</span>
      </div>
      <SvgLine
        title={title}
        data={data}
        unit={unit}
        max={max}
        warning={warning}
        critical={critical}
      />
    </section>
  );
}

function getScale(data, fixedMax, warning, critical) {
  const values = data.map((p) => num(p.value));
  if (!values.length) return { yMin: 0, yMax: fixedMax || 1, mode: "empty" };
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const thresholds = [warning, critical].filter(
    (v) => v !== undefined && v !== null,
  );
  const thresholdMin = thresholds.length ? Math.min(...thresholds) : null;

  if (thresholdMin !== null && dataMax >= thresholdMin * 0.75) {
    return { yMin: 0, yMax: fixedMax || Math.max(dataMax, 1), mode: "fixed" };
  }

  const spread = Math.max(dataMax - dataMin, 0);
  const padding = Math.max(spread * 0.35, dataMax * 0.25, 1);
  let yMin = Math.max(0, dataMin - padding);
  let yMax = dataMax + padding;
  if (yMax - yMin < 1) yMax = yMin + 1;
  if (fixedMax) yMax = Math.min(yMax, fixedMax);
  return { yMin, yMax, mode: "auto" };
}

function valueToY(value, min, max, height) {
  return (
    height - clamp((num(value) - min) / Math.max(max - min, 1), 0, 1) * height
  );
}

function SvgLine({ title, data, unit, max, warning, critical }) {
  const [hover, setHover] = useState(null);
  const width = 600;
  const height = 170;

  if (!data.length) {
    return (
      <div className="chart-empty">No metric data returned from Prometheus</div>
    );
  }

  const { yMin, yMax, mode } = getScale(data, max, warning, critical);
  const points = data
    .map((p, i) => {
      const x = data.length === 1 ? 0 : (i / (data.length - 1)) * width;
      const y = valueToY(p.value, yMin, yMax, height);
      return `${x},${y}`;
    })
    .join(" ");
  const areaPoints = `0,${height} ${points} ${width},${height}`;

  const warningY =
    warning >= yMin && warning <= yMax
      ? valueToY(warning, yMin, yMax, height)
      : null;
  const criticalY =
    critical >= yMin && critical <= yMax
      ? valueToY(critical, yMin, yMax, height)
      : null;

  function move(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const index = Math.round(ratio * (data.length - 1));
    const point = data[index];
    setHover({
      ...point,
      x: data.length === 1 ? 0 : (index / (data.length - 1)) * width,
      y: valueToY(point.value, yMin, yMax, height),
    });
  }

  return (
    <div className="svg-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onMouseMove={move}
        onMouseLeave={() => setHover(null)}
      >
        <line x1="0" y1="42" x2={width} y2="42" className="guide" />
        <line x1="0" y1="84" x2={width} y2="84" className="guide" />
        <line x1="0" y1="126" x2={width} y2="126" className="guide" />
        {warningY !== null && (
          <line
            x1="0"
            y1={warningY}
            x2={width}
            y2={warningY}
            className="guide yellow"
          />
        )}
        {criticalY !== null && (
          <line
            x1="0"
            y1={criticalY}
            x2={width}
            y2={criticalY}
            className="guide red"
          />
        )}
        <polygon points={areaPoints} className="actual-area" />
        <polyline points={points} className="actual-line" />
        {hover && (
          <>
            <line
              x1={hover.x}
              y1="0"
              x2={hover.x}
              y2={height}
              className="hover-line"
            />
            <circle cx={hover.x} cy={hover.y} r="5" className="hover-dot" />
          </>
        )}
      </svg>
      {hover && (
        <div className="tooltip">
          <strong>{title}</strong>
          <span>{hover.datetime}</span>
          <b>
            {hover.value}
            {unit}
          </b>
        </div>
      )}
      <div className="time-axis">
        <span>{data[0]?.time}</span>
        <span>{data[Math.floor(data.length / 2)]?.time}</span>
        <span>{data[data.length - 1]?.time}</span>
      </div>
      <div className="y-range">
        {round(yMin, 2)}
        {unit} ~ {round(yMax, 2)}
        {unit}
        {mode === "auto" ? " · auto scale" : ""}
      </div>
    </div>
  );
}

function MetricHistory({ logs }) {
  return (
    <div className="history-scroll">
      <div className="metric-table">
        <div className="metric-head">
          <span>Time</span>
          <span>CPU</span>
          <span>MEM</span>
          <span>Disk</span>
          <span>Inode</span>
          <span>Disk I/O</span>
          <span>Net</span>
          <span>RTT</span>
        </div>
        {logs.map((log, index) => (
          <div className="metric-row" key={`${log.datetime}-${index}`}>
            <span>{log.datetime}</span>
            <span>{round(log.cpu, 2)}%</span>
            <span>{round(log.mem, 2)}%</span>
            <span>{round(log.disk, 2)}%</span>
            <span>{round(log.inode, 2)}%</span>
            <span>{round(log.diskIo, 2)}%</span>
            <span>{round(log.net, 2)} MB/s</span>
            <span>{round(log.rtt, 2)} ms</span>
          </div>
        ))}
        {logs.length === 0 && (
          <div className="empty-box">No metric samples</div>
        )}
      </div>
    </div>
  );
}

function IssueTimeline({ issues }) {
  return (
    <div className="history-scroll">
      <div className="timeline-table">
        <div className="timeline-head">
          <span>Time</span>
          <span>Metric</span>
          <span>Value</span>
          <span>Threshold</span>
        </div>
        {issues.map((issue, index) => (
          <div className="timeline-row" key={`${issue.datetime}-${index}`}>
            <span>{issue.datetime}</span>
            <span>{issue.metric}</span>
            <span>{issue.value}</span>
            <span>{issue.threshold}</span>
          </div>
        ))}
        {issues.length === 0 && (
          <div className="empty-box">No issue points in selected range</div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
