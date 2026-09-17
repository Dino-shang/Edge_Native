chrome.runtime.sendMessage({ type: "status" }, (status) => {
  const el = document.getElementById("status");
  const idEl = document.getElementById("extId");
  const detail = document.getElementById("detail");
  if (chrome.runtime.lastError) {
    el.textContent = "Service worker not responding";
    el.className = "row bad";
    return;
  }
  idEl.textContent = status.extensionId || "(unknown)";
  if (status.connected) {
    el.textContent = status.hostReady
      ? "Native Messaging connected"
      : "Port open — waiting for host handshake";
    el.className = "row ok";
  } else {
    el.textContent = "Not connected";
    el.className = "row bad";
  }
  if (detail) {
    const lines = [];
    lines.push("host: " + (status.hostName || ""));
    lines.push("attempts: " + (status.connectAttempt || 0));
    if (status.lastHostMessageAt) lines.push("last host msg: " + status.lastHostMessageAt);
    if (status.lastDisconnect) {
      lines.push("last disconnect: " + status.lastDisconnect.message);
      lines.push("at: " + status.lastDisconnect.at);
    }
    lines.push("host log: %LOCALAPPDATA%\\edge_nm\\host.log");
    lines.push("launcher log: %LOCALAPPDATA%\\edge_nm\\launcher.log");
    detail.textContent = lines.join("\n");
  }
});
