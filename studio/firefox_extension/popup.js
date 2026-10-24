const DEFAULT_URL = "http://127.0.0.1:8765";
const state = { settings: null, scan: null, match: null, waiting: false, poll: null };
const MANUAL_ONLY_HOSTS = new Set([
  "floridaresidentsdirectory.com", "www.floridaresidentsdirectory.com",
  "nationalpublicdata.com", "www.nationalpublicdata.com",
  "beenverified.com", "www.beenverified.com"
]);

const $ = id => document.getElementById(id);

function showMessage(text, kind = "neutral") {
  const node = $("message");
  node.textContent = text;
  node.className = `message ${kind}`;
  node.hidden = !text;
}

function setReceiverStatus(text, kind = "neutral") {
  const node = $("receiverStatus");
  node.textContent = text;
  node.className = `status ${kind}`;
}

async function loadSettings() {
  const stored = await browser.storage.local.get(["receiverUrl", "receiverToken"]);
  state.settings = {
    receiverUrl: String(stored.receiverUrl || DEFAULT_URL).replace(/\/$/, ""),
    receiverToken: String(stored.receiverToken || "")
  };
}

async function receiverFetch(path, options = {}) {
  if (!state.settings.receiverToken) throw new Error("Open Receiver settings and paste the local token.");
  const response = await fetch(`${state.settings.receiverUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-OSINT-Receiver-Token": state.settings.receiverToken,
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Receiver returned ${response.status}`);
  return body;
}

async function contentHash(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function scanActivePage() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length || !/^https?:/i.test(tabs[0].url || "")) throw new Error("Open a public HTTP or HTTPS record page first.");
  const pageUrl = tabs[0].url;
  const hostname = new URL(pageUrl).hostname.toLowerCase();
  if (MANUAL_ONLY_HOSTS.has(hostname)) {
    const manualScan = {
      pageUrl,
      pageTitle: tabs[0].title || "",
      candidateNames: [],
      candidateAddresses: [],
      observedLanguage: "",
      languageConfidence: 0,
      manualRequired: true,
      inputMethod: "manual-entry",
      scannedAt: new Date().toISOString()
    };
    manualScan.contentSha256 = await contentHash(`${manualScan.pageUrl}\n${manualScan.pageTitle}`);
    state.scan = manualScan;
    state.match = null;
    return manualScan;
  }
  try {
    await browser.tabs.executeScript(tabs[0].id, { file: "content.js" });
  } catch (error) {
    if (!String(error).includes("divedeep")) throw error;
  }
  const scan = await browser.tabs.sendMessage(tabs[0].id, { type: "divedeep.scan" });
  const detected = scan.textSample ? await browser.i18n.detectLanguage(scan.textSample) : { languages: [] };
  const primary = [...(detected.languages || [])].sort((a, b) => b.percentage - a.percentage)[0];
  scan.observedLanguage = scan.declaredLanguage || primary?.language || "";
  scan.languageConfidence = scan.declaredLanguage ? 1 : Number(primary?.percentage || 0) / 100;
  scan.contentSha256 = await contentHash(`${scan.pageUrl}\n${scan.textSample}`);
  scan.inputMethod = "active-tab-structured-scan";
  delete scan.textSample;
  state.scan = scan;
  return scan;
}

async function matchCurrentScan() {
  const scan = state.scan || await scanActivePage();
  if (!scan.candidateNames.length) throw new Error("Enter the visible name and address before matching this manual-entry source.");
  state.match = await receiverFetch("/api/v1/match", {
    method: "POST",
    body: JSON.stringify({
      page_url: scan.pageUrl,
      page_title: scan.pageTitle,
      candidate_names: scan.candidateNames,
      candidate_addresses: scan.candidateAddresses
    })
  });
  render();
}

function percent(value) { return `${Math.round(Number(value || 0) * 100)}%`; }

function render() {
  const scan = state.scan;
  const match = state.match;
  $("scanPanel").hidden = !scan;
  $("manualPanel").hidden = !scan?.manualRequired;
  if (scan) {
    $("candidateName").textContent = match?.candidate_name || scan.candidateNames[0] || "No name extracted";
    $("candidateAddress").textContent = match?.candidate_address || scan.candidateAddresses[0] || "No address extracted";
    $("languageResult").textContent = scan.manualRequired ? "Automatic page-language detection disabled for this source" : (scan.observedLanguage ? `Page language: ${scan.observedLanguage} (${percent(scan.languageConfidence)})` : "Page language unavailable");
    $("scanTime").textContent = `Scanned ${new Date(scan.scannedAt).toLocaleTimeString()}`;
  }
  const matched = Boolean(match?.matched);
  $("rowPanel").hidden = !matched;
  $("businessPanel").hidden = !match?.business_entity_likely;
  if (matched) {
    $("expectedName").textContent = match.expected_owner_name;
    $("expectedAddress").textContent = `${match.expected_property_address} · ${match.expected_location}`;
    $("nameScore").textContent = percent(match.name_similarity);
    $("addressScore").textContent = percent(match.address_similarity);
    const already = $("captureMode").value === "language-evidence" ? match.language_already_filled : match.already_filled;
    $("rowState").textContent = already ? "Already filled" : match.verification_result;
    $("rowState").className = `status ${already ? "warning" : "good"}`;
    $("replaceLabel").hidden = !already;
  }
  const mode = $("captureMode").value;
  const replaceRequired = matched && (mode === "language-evidence" ? match.language_already_filled : match.already_filled);
  const replacementAllowed = !replaceRequired || $("replaceExisting").checked;
  const modeReady = mode === "language-evidence"
    ? Boolean(scan?.observedLanguage && scan.languageConfidence >= 0.5)
    : Boolean(match?.owner_submit_ready && match?.source_key_matches_page);
  const ready = matched && !match.business_entity_likely && modeReady && replacementAllowed;
  $("confirmButton").disabled = !ready || state.waiting;
  $("signalButton").disabled = !ready;
  $("signalButton").textContent = state.waiting ? "Waiting — click to cancel" : "Wait for Studio signal";
  if (scan?.manualRequired && !matched) showMessage("Enter the visible name and property address, then match them to the queued row.");
  else if (!matched) showMessage("No queued owner row is a close enough name match for this page.", "warning");
  else if (match.business_entity_likely) showMessage("Capture blocked: this owner appears to be an organization.", "warning");
  else if (mode === "owner-verification" && !match.source_key_matches_page) showMessage("This page is not the configured directory source for the queued row. Switch to public-profile language or open the queued source.", "warning");
  else if (mode === "owner-verification" && !match.owner_submit_ready) showMessage("The name matches, but no address was extracted. Review the page before submitting.", "warning");
  else if (mode === "owner-verification" && Number(match.address_similarity) < 0.72) showMessage("The name closely matches, but the address conflicts. Confirmation will save a conflict result for analyst review.", "warning");
  else showMessage("Review the matched row, then confirm now or wait for the Studio signal.");
}

async function submitCapture(forceRescan = false, expectedVerificationId = "") {
  if (!state.scan?.manualRequired && (forceRescan || $("rescanBeforeSubmit").checked)) {
    await scanActivePage();
    await matchCurrentScan();
  }
  const scan = state.scan;
  const match = state.match;
  if (!scan || !match?.matched) throw new Error("No confirmed row match is available.");
  if (expectedVerificationId && match.verification_id !== expectedVerificationId) {
    throw new Error("The re-scan matched a different input row. Submission was stopped for review.");
  }
  const result = await receiverFetch("/api/v1/submit", {
    method: "POST",
    body: JSON.stringify({
      verification_id: match.verification_id,
      capture_mode: $("captureMode").value,
      page_url: scan.pageUrl,
      page_title: scan.pageTitle,
      candidate_name: match.candidate_name,
      candidate_address: match.candidate_address,
      observed_language: scan.observedLanguage,
      language_confidence: scan.languageConfidence,
      content_sha256: scan.contentSha256,
      input_method: scan.inputMethod,
      replace_existing: $("replaceExisting").checked
    })
  });
  showMessage(`Saved ${result.result}. Receipt ${result.receipt_id}.`, "good");
  setReceiverStatus("Saved", "good");
  await matchCurrentScan();
}

async function toggleSignalWait() {
  if (state.waiting) {
    state.waiting = false;
    clearInterval(state.poll);
    state.poll = null;
    render();
    return;
  }
  if (!state.match?.verification_id) return;
  const waitingVerificationId = state.match.verification_id;
  state.waiting = true;
  render();
  state.poll = setInterval(async () => {
    try {
      const result = await receiverFetch(`/api/v1/signal?verification_id=${encodeURIComponent(waitingVerificationId)}`);
      if (result.signaled) {
        clearInterval(state.poll);
        state.poll = null;
        state.waiting = false;
        await submitCapture(true, waitingVerificationId);
      }
    } catch (error) {
      clearInterval(state.poll);
      state.poll = null;
      state.waiting = false;
      showMessage(error.message, "error");
      render();
    }
  }, 1500);
}

async function initialize() {
  try {
    await loadSettings();
    const health = await fetch(`${state.settings.receiverUrl}/health`).then(response => response.json());
    setReceiverStatus(health.status === "ready" ? "Receiver ready" : "Receiver unavailable", health.status === "ready" ? "good" : "warning");
    await scanActivePage();
    if (state.scan.manualRequired) render();
    else await matchCurrentScan();
  } catch (error) {
    setReceiverStatus("Setup needed", "warning");
    showMessage(error.message, "error");
  }
}

$("confirmButton").addEventListener("click", () => submitCapture(false).catch(error => showMessage(error.message, "error")));
$("signalButton").addEventListener("click", () => toggleSignalWait().catch(error => showMessage(error.message, "error")));
$("rescanButton").addEventListener("click", async () => {
  try { await scanActivePage(); if (state.scan.manualRequired) render(); else await matchCurrentScan(); } catch (error) { showMessage(error.message, "error"); }
});
$("manualMatchButton").addEventListener("click", async () => {
  try {
    if (!state.scan?.manualRequired) return;
    state.scan.candidateNames = [$("manualName").value.trim()].filter(Boolean);
    state.scan.candidateAddresses = [$("manualAddress").value.trim()].filter(Boolean);
    state.scan.contentSha256 = await contentHash(`${state.scan.pageUrl}\n${state.scan.pageTitle}\n${state.scan.candidateNames[0] || ""}\n${state.scan.candidateAddresses[0] || ""}`);
    await matchCurrentScan();
  } catch (error) { showMessage(error.message, "error"); }
});
$("captureMode").addEventListener("change", render);
$("replaceExisting").addEventListener("change", render);
$("openSunbiz").addEventListener("click", () => browser.tabs.create({ url: "https://dos.fl.gov/sunbiz/search/" }));
window.addEventListener("unload", () => state.poll && clearInterval(state.poll));
initialize();
