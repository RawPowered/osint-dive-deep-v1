const $ = id => document.getElementById(id);

function message(text, kind = "neutral") {
  const node = $("message");
  node.textContent = text;
  node.className = `message ${kind}`;
  node.hidden = !text;
}

async function load() {
  const stored = await browser.storage.local.get(["receiverUrl", "receiverToken"]);
  $("receiverUrl").value = stored.receiverUrl || "http://127.0.0.1:8765";
  $("receiverToken").value = stored.receiverToken || "";
}

async function save() {
  const receiverUrl = $("receiverUrl").value.trim().replace(/\/$/, "");
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(receiverUrl)) {
    throw new Error("Receiver URL must use loopback HTTP only.");
  }
  const receiverToken = $("receiverToken").value.trim();
  if (receiverToken.length < 32) throw new Error("Paste the token printed by ./run.sh --receiver or --with-receiver.");
  await browser.storage.local.set({ receiverUrl, receiverToken });
  message("Settings saved.", "good");
}

async function test() {
  const receiverUrl = $("receiverUrl").value.trim().replace(/\/$/, "");
  const response = await fetch(`${receiverUrl}/health`);
  const body = await response.json();
  if (!response.ok || body.status !== "ready") throw new Error("Receiver did not report ready.");
  message("Receiver is ready. Raw DOM acceptance is disabled.", "good");
}

$("saveButton").addEventListener("click", () => save().catch(error => message(error.message, "error")));
$("testButton").addEventListener("click", () => test().catch(error => message(error.message, "error")));
$("revealToken").addEventListener("change", event => { $("receiverToken").type = event.target.checked ? "text" : "password"; });
load();
