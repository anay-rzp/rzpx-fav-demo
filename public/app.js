/* ═══════════════════════════════════════════════════════════════
   LendBridge — RazorpayX FAV Demo  |  app.js
   ═══════════════════════════════════════════════════════════════ */

const App = (() => {
  // ─── State ─────────────────────────────────────────────────
  let currentStep = 0;
  let isDemoMode = true;
  let verifyMode = "upi"; // 'upi' | 'rpd'
  let rpdFavId = null;
  let rpdPollTimer = null;
  let rpdIsDemo = false;
  let rpdWaiting = false;
  let _visibilityHandler = null;
  let _rpdInitPromise = null;  // tracks the in-flight _initRpdSession promise
  let _rpdAppUrls = {};        // { appName → deep-link URL } populated after init

  const applicant = {
    name: "",
    email: "",
    phone: "",
    loanAmount: 0,
  };
  let bankData = null;

  // ─── Screen IDs in order ────────────────────────────────────
  const SCREENS = [
    "screen-welcome",
    "screen-details",
    "screen-verify",
    "screen-verifying",
    "screen-success",
  ];

  // ─── Hash routing maps ──────────────────────────────────────
  // step 3 (verifying) is transient — no hash entry, replaces with #verify
  const STEP_HASHES = ["#welcome", "#details", "#verify", null, "#success"];
  const HASH_TO_STEP = { "#welcome": 0, "#details": 1, "#verify": 2, "#success": 4 };

  // ─── Init ───────────────────────────────────────────────────
  async function init() {
    try {
      const res = await fetch("/api/config");
      const cfg = await res.json();
      isDemoMode = cfg.demo;
    } catch {
      isDemoMode = true;
    }

    if (isDemoMode) {
      document.getElementById("demo-pill").classList.remove("hidden");
    }

    bindForms();
    window.addEventListener("hashchange", onHashChange);

    // Handle initial URL hash — either deep-link to a valid step or start at welcome
    if (location.hash && HASH_TO_STEP[location.hash] !== undefined) {
      onHashChange();
    } else {
      history.replaceState(null, "", "#welcome");
      showScreen(0);
    }
  }

  // ─── UPI Drawer ─────────────────────────────────────────────
  function openUpiDrawer() {
    if (window.innerWidth <= 480) {
      document.getElementById("panel-upi").classList.add("open");
      document.getElementById("upi-drawer-backdrop").classList.add("open");
      setTimeout(() => {
        const inp = document.getElementById("inp-upi");
        if (inp) inp.focus();
      }, 320);
    } else {
      const inp = document.getElementById("inp-upi");
      if (inp) inp.focus();
    }
  }

  function closeUpiDrawer() {
    document.getElementById("panel-upi").classList.remove("open");
    document.getElementById("upi-drawer-backdrop").classList.remove("open");
    hideVerifyError();
  }

  // ─── Mobile UI ──────────────────────────────────────────────
  const ARROW = '';

  function setFooterCTA(label, action) {
    const btn = document.getElementById("mobile-footer-btn");
    btn.innerHTML = label + ARROW;
    btn.onclick = action;
    btn.disabled = false;
  }

  function updateVerifyFooter() {
    const footer = document.getElementById("mobile-footer");
    const rpdPay = document.getElementById("rpd-pay");
    const paying = rpdPay && !rpdPay.classList.contains("hidden");

    if (paying) {
      footer.classList.add("hidden");
      return;
    }

    footer.classList.remove("hidden");
    const rpdNote = document.getElementById("rpd-footer-note");
    if (verifyMode === "upi") {
      setFooterCTA("Proceed", () => openUpiDrawer());
      if (rpdNote) rpdNote.classList.add("hidden");
    } else {
      const isMobile = window.innerWidth <= 480;
      setFooterCTA(
        "Start Verification",
        isMobile ? () => openRpdDrawer() : () => startRPD(),
      );
      if (rpdNote) rpdNote.classList.remove("hidden");
    }
  }

  function updateMobileUI(step) {
    const footer = document.getElementById("mobile-footer");

    const footerNote = document.getElementById("mobile-footer-note");
    if (footerNote) footerNote.classList.toggle("hidden", step !== 0);

    if (step === 0) {
      footer.classList.remove("hidden");
      setFooterCTA("Apply Now", () => goTo(1));
    } else if (step === 1) {
      footer.classList.remove("hidden");
      setFooterCTA("Continue", () =>
        document.getElementById("form-details").requestSubmit(),
      );
    } else if (step === 2) {
      updateVerifyFooter();
    } else if (step === 3) {
      footer.classList.add("hidden");
    } else if (step === 4) {
      footer.classList.remove("hidden");
      setFooterCTA("Start New Application", reset);
    } else {
      footer.classList.add("hidden");
    }
  }

  // ─── Navigation ─────────────────────────────────────────────
  function goTo(step) {
    currentStep = step;
    showScreen(step);
    updateProgress(step);
    window.scrollTo({ top: 0, behavior: "smooth" });
    const hash = STEP_HASHES[step];
    if (hash) {
      history.pushState(null, "", hash);
    } else {
      // Transient screen (verifying) — replace so Back skips it
      history.replaceState(null, "", "#verify");
    }
  }

  function onHashChange() {
    const hash = location.hash || "#welcome";
    let step = HASH_TO_STEP[hash];
    if (step === undefined) step = 0;

    // If navigating away while RPD is mid-flow, clean up the session and timer
    if (step !== 3 && rpdWaiting) cancelRPD();

    // Guards: steps with data dependencies
    if (step === 2 && !applicant.name) step = 1;
    if (step === 4 && !bankData) step = 0;

    // If guard redirected, fix the URL too (replaceState — don't grow history)
    const targetHash = STEP_HASHES[step];
    if (targetHash && targetHash !== location.hash) {
      history.replaceState(null, "", targetHash);
    }

    currentStep = step;
    showScreen(step);
    updateProgress(step);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showScreen(step) {
    SCREENS.forEach((id) => {
      document.getElementById(id).classList.remove("active");
    });
    document.getElementById(SCREENS[step]).classList.add("active");

    const progressBar = document.getElementById("progress-bar");
    progressBar.classList.toggle("hidden", step === 0 || step === 4);

    if (step !== 3) document.body.classList.remove("on-verifying");
    if (step !== 4) document.body.classList.remove("on-success");

    updateMobileUI(step);
  }

  function updateProgress(step) {
    const fill = document.getElementById("progress-bar-fill");
    if (fill) {
      const pct = step >= 1 && step <= 3 ? Math.round((step / 3) * 100) : 0;
      fill.style.width = pct + "%";
    }

    const si = document.getElementById("step-indicator");
    if (si) {
      const show = step >= 1 && step <= 2;
      si.classList.toggle("hidden", !show);
      for (let i = 1; i <= 3; i++) {
        const item = document.getElementById("si-" + i);
        if (!item) continue;
        item.classList.remove("active", "done");
        if (step > i) item.classList.add("done");
        else if (step === i) item.classList.add("active");
      }
      for (let i = 1; i <= 2; i++) {
        const line = document.getElementById("si-line-" + i);
        if (line) line.classList.toggle("done", step > i);
      }
    }
  }

  // ─── Verification mode switching ─────────────────────────────
  function switchMode(mode) {
    verifyMode = mode;
    document.querySelectorAll(".verify-option").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    document
      .getElementById("panel-upi")
      .classList.toggle("active", mode === "upi");
    document
      .getElementById("panel-rpd")
      .classList.toggle("active", mode === "rpd");

    clearFieldError("inp-upi", "err-upi");
    hideVerifyError();
    hideRPDError();
    if (currentStep === 2) updateVerifyFooter();
  }

  // ─── Form binding ────────────────────────────────────────────
  function bindForms() {
    document
      .getElementById("form-details")
      .addEventListener("submit", onDetailsSubmit);
    document
      .getElementById("form-verify")
      .addEventListener("submit", onVerifySubmit);
  }

  // ─── Step 1 — Details validation ─────────────────────────────
  function onDetailsSubmit(e) {
    e.preventDefault();
    let valid = true;

    const name = document.getElementById("inp-name").value.trim();
    const email = document.getElementById("inp-email").value.trim();
    const phone = document.getElementById("inp-phone").value.trim();
    const loan = document.getElementById("inp-loan").value.trim();

    clearFieldError("inp-name", "err-name");
    clearFieldError("inp-email", "err-email");
    clearFieldError("inp-phone", "err-phone");
    clearFieldError("inp-loan", "err-loan");

    if (!name || name.length < 2) {
      setFieldError("inp-name", "err-name", "Please enter your full name");
      valid = false;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFieldError("inp-email", "err-email", "Enter a valid email address");
      valid = false;
    }
    if (!phone || !/^\d{10}$/.test(phone)) {
      setFieldError(
        "inp-phone",
        "err-phone",
        "Enter a valid 10-digit mobile number",
      );
      valid = false;
    }
    const loanNum = parseInt(loan);
    if (!loan || isNaN(loanNum) || loanNum < 50000 || loanNum > 5000000) {
      setFieldError(
        "inp-loan",
        "err-loan",
        "Enter an amount between ₹50,000 and ₹50,00,000",
      );
      valid = false;
    }

    if (!valid) return;

    applicant.name = name;
    applicant.email = email;
    applicant.phone = phone;
    applicant.loanAmount = loanNum;

    goTo(2);
  }

  // ─── Step 2 — UPI ID verification ────────────────────────────
  async function onVerifySubmit(e) {
    e.preventDefault();

    const value = document.getElementById("inp-upi").value.trim();
    clearFieldError("inp-upi", "err-upi");
    if (!value || !isValidUPI(value)) {
      setFieldError(
        "inp-upi",
        "err-upi",
        "Enter a valid UPI ID (e.g. name@okhdfcbank)",
      );
      return;
    }

    hideVerifyError();

    // Navigate immediately — user sees the verifying screen with no delay
    closeUpiDrawer();
    beginVerifying();

    try {
      const res = await fetch("/api/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "upi",
          value: value,
          name: applicant.name,
          email: applicant.email,
          phone: applicant.phone,
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success)
        throw new Error(json.error || "Validation failed — please try again.");

      bankData = json.data;
      scheduleVerifyFields(bankData);
    } catch (err) {
      goTo(2);
      showVerifyError(err.message || "Something went wrong. Please try again.");
    }
  }

  // ─── Step 2 — Reverse Penny Drop: desktop initiate ───────────
  // Used on desktop only; mobile uses openRpdDrawer → selectRpdApp
  async function startRPD() {
    const btn = document.getElementById("btn-start-rpd");
    btn.disabled = true;
    btn.textContent = "Starting…";

    try {
      const res = await fetch("/api/validate-rpd", { method: "POST" });
      const json = await res.json();

      if (!res.ok || !json.success)
        throw new Error(json.error || "Failed to start verification.");

      rpdFavId = json.favId;
      rpdIsDemo = json.demo;

      document.getElementById("rpd-intro").classList.add("hidden");
      document.getElementById("rpd-pay").classList.remove("hidden");
      updateVerifyFooter();

      if (json.demo) {
        rpdPollTimer = setTimeout(() => {
          bankData = _rpdMockData();
          startVerifyAnimation(bankData);
        }, 1500);
        return;
      }

      if (json.qrCode) {
        document.getElementById("rpd-qr-wrap").classList.remove("hidden");
        document.getElementById("rpd-apps-wrap").classList.add("hidden");
        document.getElementById("rpd-qr-img").src =
          "data:image/png;base64," + json.qrCode;
      }
      pollRPD(rpdFavId);
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML =
        'Start Verification';
      showRPDError(err.message || "Failed to start. Please try again.");
    }
  }

  // ─── Step 2 — Mobile RPD: open app selection drawer ──────────
  function openRpdDrawer() {
    cancelRPD(); // clear any stale session first
    const drawer = document.getElementById("rpd-app-drawer");
    const backdrop = document.getElementById("rpd-drawer-backdrop");
    if (drawer) drawer.classList.add("open");
    if (backdrop) backdrop.classList.add("open");

    // Initiate session in background while drawer is open; store promise so
    // selectRpdApp can wait on it if the user taps before init resolves.
    _rpdInitPromise = _initRpdSession().catch((err) => {
      closeRpdDrawer();
      showRPDError(err.message || "Failed to start. Please try again.");
    });
  }

  function closeRpdDrawer() {
    const drawer = document.getElementById("rpd-app-drawer");
    const backdrop = document.getElementById("rpd-drawer-backdrop");
    if (drawer) drawer.classList.remove("open");
    if (backdrop) backdrop.classList.remove("open");
  }

  function selectRpdApp(appName) {
    closeRpdDrawer();
    _showRpdWaiting(appName);

    if (rpdIsDemo) {
      // Demo: start the auto-complete timer now that user has "tapped"
      rpdPollTimer = setTimeout(() => {
        bankData = _rpdMockData();
        _hideRpdWaiting();
        startVerifyAnimation(bankData);
      }, 1500);
      return;
    }

    // Live: navigate to the UPI app's deep-link URL and snap-check on return.
    // If _initRpdSession hasn't resolved yet (race condition), wait for it first.
    function doNavigate() {
      if (!rpdWaiting) return; // user cancelled while we were waiting
      const url = _rpdAppUrls[appName];
      if (url) window.location.href = url;
    }

    if (_rpdAppUrls[appName]) {
      doNavigate();
    } else {
      (_rpdInitPromise || Promise.resolve()).then(doNavigate).catch(() => {});
    }

    _watchForReturn();
  }

  // ─── RPD internal helpers ─────────────────────────────────────
  async function _initRpdSession() {
    const res = await fetch("/api/validate-rpd", { method: "POST" });
    const json = await res.json();

    if (!res.ok || !json.success)
      throw new Error(json.error || "Failed to start verification.");

    rpdFavId = json.favId;
    rpdIsDemo = json.demo;

    if (!json.demo) {
      // Store URLs so selectRpdApp can navigate even if the user tapped early
      _rpdAppUrls = {
        'PhonePe':    json.phonepeUrl || null,
        'Google Pay': json.gpayUrl    || null,
        'Paytm':      json.paytmUrl   || null,
        'BHIM':       json.bhimUrl    || null,
      };
      // Also set hrefs on drawer rows for the happy-path (session ready before tap)
      if (json.phonepeUrl)
        document.getElementById("rpd-row-phonepe").href = json.phonepeUrl;
      if (json.gpayUrl)
        document.getElementById("rpd-row-gpay").href = json.gpayUrl;
      if (json.paytmUrl)
        document.getElementById("rpd-row-paytm").href = json.paytmUrl;
      if (json.bhimUrl)
        document.getElementById("rpd-row-bhim").href = json.bhimUrl;
      pollRPD(rpdFavId);
    }
  }

  function _showRpdWaiting(appName) {
    rpdWaiting = true;
    goTo(3);

    const spinner = document.getElementById("verify-header-spinner");
    const badge = document.getElementById("verify-header-badge");
    const title = document.getElementById("verify-header-title");
    if (spinner) spinner.classList.remove("hiding");
    if (badge) badge.classList.add("hidden");
    if (title) {
      title.textContent = "Waiting for payment";
      title.style.cssText = "";
    }

    const body = document.getElementById("rpd-waiting-body");
    const appSpan = document.getElementById("rpd-selected-app-name");
    if (appSpan) appSpan.textContent = appName;
    if (body) body.classList.remove("hidden");

    const card = document.querySelector("#screen-verifying .verify-card-wrap");
    if (card) card.classList.add("hidden");

    document.getElementById("verifying-footer").classList.add("hidden");
    if (window.innerWidth <= 480) {
      document.getElementById("mobile-footer").classList.add("hidden");
    }

    document.getElementById("screen-verifying").classList.add("rpd-waiting");
  }

  function _hideRpdWaiting() {
    rpdWaiting = false;
    const body = document.getElementById("rpd-waiting-body");
    if (body) body.classList.add("hidden");
    const card = document.querySelector("#screen-verifying .verify-card-wrap");
    if (card) card.classList.remove("hidden");
    document.getElementById("screen-verifying").classList.remove("rpd-waiting");
  }

  function _rpdMockData() {
    return {
      vpa: "demo@okhdfcbank",
      bankName: "HDFC Bank",
      bankColor: "#004C8F",
      registeredName: applicant.name || "Rahul Kumar",
      accountNumber: "50XXXXXX6789",
      accountType: "saving",
      upiInstrument: "bank account",
      ifscCode: "HDFC0001234",
      accountStatus: "active",
      accountVerified: true,
      validationId: rpdFavId,
      utr: null,
    };
  }

  // ─── Step 2 — Reverse Penny Drop: poll ───────────────────────
  function pollRPD(favId) {
    rpdPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/validate-rpd/${favId}`);
        const json = await res.json();

        if (!res.ok) throw new Error(json.error || "Poll failed");

        if (json.status === "completed" && json.data) {
          clearInterval(rpdPollTimer);
          bankData = json.data;
          _hideRpdWaiting();
          startVerifyAnimation(bankData);
        } else if (json.status === "failed") {
          clearInterval(rpdPollTimer);
          showRPDError("Verification failed. Please try again.");
        }
        // else: still pending — keep polling
      } catch (err) {
        clearInterval(rpdPollTimer);
        showRPDError(err.message || "Connection error. Please try again.");
      }
    }, 3000);
  }

  // ─── Step 2 — Snap-check when user returns from UPI app ───────
  function _watchForReturn() {
    _clearVisibilityWatch();
    _visibilityHandler = function () {
      if (document.visibilityState !== "visible") return;
      _clearVisibilityWatch();
      if (!rpdFavId) return;
      // Immediately ping the server the moment the user switches back
      fetch(`/api/validate-rpd/${rpdFavId}`)
        .then((r) => r.json())
        .then((json) => {
          if (json.status === "completed" && json.data) {
            clearInterval(rpdPollTimer);
            bankData = json.data;
            _hideRpdWaiting();
            startVerifyAnimation(bankData);
          }
        })
        .catch(() => {}); // background poll will handle errors
    };
    document.addEventListener("visibilitychange", _visibilityHandler);
  }

  function _clearVisibilityWatch() {
    if (_visibilityHandler) {
      document.removeEventListener("visibilitychange", _visibilityHandler);
      _visibilityHandler = null;
    }
  }

  // ─── Step 2 — Reverse Penny Drop: cancel ─────────────────────
  function cancelRPD() {
    _clearVisibilityWatch();
    clearInterval(rpdPollTimer);
    clearTimeout(rpdPollTimer);
    rpdFavId = null;
    rpdPollTimer = null;
    rpdIsDemo = false;
    rpdWaiting = false;
    _rpdAppUrls = {};
    // _rpdInitPromise is intentionally left — any in-flight fetch resolves harmlessly;
    // openRpdDrawer replaces it on the next open.

    document.getElementById("rpd-intro").classList.remove("hidden");
    document.getElementById("rpd-pay").classList.add("hidden");
    document.getElementById("rpd-qr-wrap").classList.remove("hidden");
    document.getElementById("rpd-apps-wrap").classList.add("hidden");
    hideRPDError();

    const btn = document.getElementById("btn-start-rpd");
    btn.disabled = false;
    btn.innerHTML =
      'Start Verification';
    if (currentStep === 2) updateVerifyFooter();
  }

  // ─── UPI format validator ─────────────────────────────────────
  function isValidUPI(vpa) {
    return /^[a-zA-Z0-9._\-+]+@[a-zA-Z0-9]+$/.test(vpa);
  }

  // ─── Populate success screen ──────────────────────────────────
  function populateSuccess() {
    const badge = document.getElementById("success-badge");
    if (badge) {
      badge.classList.add("hidden");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => badge.classList.remove("hidden")),
      );
    }
    document.body.classList.add("on-success");

    const appId =
      "LB-" +
      new Date().getFullYear() +
      "-" +
      Math.random().toString(36).slice(2, 8).toUpperCase();
    setText("success-app-id", appId);
    setText("success-name", applicant.name || "—");
    setText("success-bank", bankData ? `${bankData.bankName} (Verified)` : "—");
    setText(
      "success-loan",
      applicant.loanAmount
        ? `₹${Number(applicant.loanAmount).toLocaleString("en-IN")}`
        : "—",
    );
  }

  // ─── Verify animation (unified screen 3) ────────────────────
  let _verifyRunId = 0;

  // beginVerifying — UI only, no data needed. Call immediately on submit.
  // Pass initialTitle to skip the "Initiating paisa drop…" phase (RPD flow).
  function beginVerifying(initialTitle) {
    const runId = ++_verifyRunId;
    goTo(3);

    const verifyingList = document.querySelector(
      "#screen-verifying .verify-details-list",
    );
    if (verifyingList) verifyingList.classList.remove("verified");
    const waitingBody = document.getElementById("rpd-waiting-body");
    if (waitingBody) waitingBody.classList.add("hidden");
    [
      "vd-vpa",
      "vd-name",
      "vd-account",
      "vd-account-type",
      "vd-upi-instrument",
      "vd-bank",
      "vd-ifsc",
      "vd-status",
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<span class="vdr-shimmer"></span>';
    });
    // Show all optional rows during shimmer (data will hide them if absent)
    ["vd-row-account", "vd-row-account-type", "vd-row-upi-instrument", "vd-row-ifsc"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.remove("hidden");
    });

    const spinner = document.getElementById("verify-header-spinner");
    const badge = document.getElementById("verify-header-badge");
    const title = document.getElementById("verify-header-title");
    if (spinner) spinner.classList.remove("hiding");
    if (badge)   badge.classList.add("hidden");
    if (title) {
      title.textContent = initialTitle || "Initiating paisa drop…";
      title.style.opacity = "";
      title.style.transform = "";
      title.style.transition = "";
      title.style.color = "";
    }
    document.getElementById("verifying-footer").classList.add("hidden");

    // Phase 2 crossfade — only for UPI flow (no initialTitle)
    if (!initialTitle) {
      setTimeout(() => {
        if (_verifyRunId !== runId) return;
        const t = document.getElementById("verify-header-title");
        if (!t || t.style.color) return;
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduced) { t.textContent = "Fetching bank details…"; return; }
        t.style.transition = "opacity 0.15s ease";
        t.style.opacity = "0";
        setTimeout(() => {
          if (_verifyRunId !== runId || t.style.color) return;
          t.textContent = "Fetching bank details…";
          t.style.opacity = "1";
        }, 200);
      }, 800);
    }
  }

  // jaroWinkler — fuzzy name similarity score (0–1)
  function jaroWinkler(a, b) {
    const norm = s => s.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    a = norm(a); b = norm(b);
    if (a === b) return 1;
    if (!a || !b) return 0;
    const win = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const am = new Array(a.length).fill(false);
    const bm = new Array(b.length).fill(false);
    let m = 0;
    for (let i = 0; i < a.length; i++) {
      const lo = Math.max(0, i - win), hi = Math.min(i + win + 1, b.length);
      for (let j = lo; j < hi; j++) {
        if (bm[j] || a[i] !== b[j]) continue;
        am[i] = bm[j] = true; m++; break;
      }
    }
    if (!m) return 0;
    let t = 0, k = 0;
    for (let i = 0; i < a.length; i++) {
      if (!am[i]) continue;
      while (!bm[k]) k++;
      if (a[i] !== b[k]) t++;
      k++;
    }
    const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
    let p = 0;
    for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
      if (a[i] === b[i]) p++; else break;
    }
    return jaro + p * 0.1 * (1 - jaro);
  }

  function nameMatchInfo(score) {
    const pct = Math.round(score * 100);
    if (pct >= 90) return { pct, label: 'High Match', cls: 'match-high' };
    if (pct >= 70) return { pct, label: 'Partial Match', cls: 'match-partial' };
    return { pct, label: 'Low Match', cls: 'match-low' };
  }

  // scheduleVerifyFields — populate shimmer cells once data is available
  function scheduleVerifyFields(data) {
    const runId = _verifyRunId;

    const rowAccount = document.getElementById("vd-row-account");
    const rowAccountType = document.getElementById("vd-row-account-type");
    const rowUpiInstrument = document.getElementById("vd-row-upi-instrument");
    const rowIfsc = document.getElementById("vd-row-ifsc");
    if (rowAccount) rowAccount.classList.toggle("hidden", !data.accountNumber);
    if (rowAccountType) rowAccountType.classList.toggle("hidden", !data.accountType);
    if (rowUpiInstrument) rowUpiInstrument.classList.toggle("hidden", !data.upiInstrument);
    if (rowIfsc) rowIfsc.classList.toggle("hidden", !data.ifscCode);

    function toTitleCase(str) {
      if (!str) return str;
      return str.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    }

    function fillField(id, value) {
      if (_verifyRunId !== runId) return;
      const el = document.getElementById(id);
      if (!el || !value) return;
      const span = document.createElement("span");
      span.className = "vdr-val-text";
      span.textContent = value;
      el.innerHTML = "";
      el.appendChild(span);
    }

    setTimeout(() => fillField("vd-vpa", data.vpa || "—"), 150);
    setTimeout(() => {
      if (_verifyRunId !== runId) return;
      const el = document.getElementById("vd-name");
      if (!el) return;
      const displayName = data.registeredName || applicant.name || "—";
      const wrap = document.createElement("span");
      wrap.className = "vdr-name-wrap";
      const nameSpan = document.createElement("span");
      nameSpan.className = "vdr-val-text";
      nameSpan.textContent = displayName;
      wrap.appendChild(nameSpan);
      if (data.registeredName && applicant.name) {
        const score = jaroWinkler(applicant.name, data.registeredName);
        const { pct, label, cls } = nameMatchInfo(score);
        const scoreSpan = document.createElement("span");
        scoreSpan.className = `vdr-match-score ${cls}`;
        scoreSpan.textContent = `${pct}% match`;
        wrap.appendChild(scoreSpan);
      }
      el.innerHTML = "";
      el.appendChild(wrap);
    }, 350);
    setTimeout(() => fillField("vd-account", data.accountNumber), 550);
    setTimeout(() => fillField("vd-account-type", toTitleCase(data.accountType)), 750);
    setTimeout(() => fillField("vd-upi-instrument", toTitleCase(data.upiInstrument)), 950);
    setTimeout(() => fillField("vd-bank", data.bankName || "—"), 1150);
    setTimeout(() => fillField("vd-ifsc", data.ifscCode), 1350);
    setTimeout(() => {
      if (_verifyRunId !== runId) return;
      const el = document.getElementById("vd-status");
      if (!el) return;
      el.innerHTML =
        '<span class="vdr-val-text"><span class="status-active-pill"><span class="status-active-dot"></span>Active</span></span>';
    }, 1550);
    setTimeout(() => {
      if (_verifyRunId === runId) showVerifySuccess();
    }, 1750);
  }

  // startVerifyAnimation — RPD flow: data already available, skip initiation phase
  function startVerifyAnimation(data) {
    beginVerifying('Fetching bank details…');
    scheduleVerifyFields(data);
  }

  function showVerifySuccess() {
    const list = document.querySelector(
      "#screen-verifying .verify-details-list",
    );
    if (list) list.classList.add("verified");

    const spinner = document.getElementById("verify-header-spinner");
    const badge = document.getElementById("verify-header-badge");
    const title = document.getElementById("verify-header-title");

    if (spinner) spinner.classList.add("hiding");

    setTimeout(() => {
      if (badge) badge.classList.remove("hidden");
    }, 200);

    // 3. Title crossfade: slide up + fade out old text, slide in + fade in new text
    if (title) {
      title.style.transition = "opacity 0.15s ease, transform 0.15s ease";
      title.style.opacity = "0";
      title.style.transform = "translateY(-5px)";

      setTimeout(() => {
        title.textContent = "Bank Account Verified Successfully";
        title.style.color = "var(--success-dark)";
        title.style.transition = "none";
        title.style.opacity = "0";
        title.style.transform = "translateY(7px)";

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            title.style.transition =
              "opacity 0.35s cubic-bezier(0.25, 1, 0.5, 1), transform 0.35s cubic-bezier(0.25, 1, 0.5, 1)";
            title.style.opacity = "1";
            title.style.transform = "translateY(0)";
          });
        });
      }, 180);
    }

    // 4. Footer fades in, background gradient appears
    document.getElementById("verifying-footer").classList.remove("hidden");
    document.body.classList.add("on-verifying");

    if (window.innerWidth <= 480) {
      const footer = document.getElementById("mobile-footer");
      footer.classList.remove("hidden");
      setFooterCTA("Submit Application", submitApplication);
    }
  }

  function submitApplication() {
    goToPublic(4);
  }

  function showVerifyError(msg) {
    document.getElementById("verify-error-msg").textContent = msg;
    document.getElementById("verify-error").classList.remove("hidden");
  }
  function hideVerifyError() {
    document.getElementById("verify-error").classList.add("hidden");
  }
  function showRPDError(msg) {
    document.getElementById("rpd-error-msg").textContent = msg;
    document.getElementById("rpd-error").classList.remove("hidden");
  }
  function hideRPDError() {
    document.getElementById("rpd-error").classList.add("hidden");
  }

  // ─── Field helpers ─────────────────────────────────────────────
  function setFieldError(inputId, errId, msg) {
    const inp = document.getElementById(inputId);
    if (inp) inp.classList.add("is-invalid");
    const err = document.getElementById(errId);
    if (err) err.textContent = msg;
  }
  function clearFieldError(inputId, errId) {
    const inp = document.getElementById(inputId);
    if (inp) inp.classList.remove("is-invalid");
    const err = document.getElementById(errId);
    if (err) err.textContent = "";
  }
  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ─── Reset ────────────────────────────────────────────────────
  function reset() {
    applicant.name = applicant.email = applicant.phone = "";
    applicant.loanAmount = 0;
    bankData = null;

    document.getElementById("inp-name").value = "";
    document.getElementById("inp-email").value = "";
    document.getElementById("inp-phone").value = "";
    document.getElementById("inp-loan").value = "";
    document.getElementById("inp-upi").value = "";

    cancelRPD();
    hideVerifyError();
    switchMode("upi");
    goTo(0);
  }

  // ─── Celebration confetti ─────────────────────────────────────
  function triggerConfetti() {
    const COLORS = [
      "#1D4ED8",
      "#059669",
      "#7C3AED",
      "#F59E0B",
      "#EF4444",
      "#06B6D4",
      "#10B981",
    ];
    const wrap = document.createElement("div");
    wrap.className = "confetti-wrap";
    document.body.appendChild(wrap);

    for (let i = 0; i < 60; i++) {
      const p = document.createElement("div");
      p.className = "confetti-p";
      const size = Math.random() * 5 + 3;
      const drift = ((Math.random() - 0.5) * 100).toFixed(1);
      p.style.cssText = `
        left: ${Math.random() * 100}%;
        width: ${size}px;
        height: ${size * (Math.random() > 0.4 ? 1 : 1.8)}px;
        background: ${COLORS[Math.floor(Math.random() * COLORS.length)]};
        border-radius: ${Math.random() > 0.4 ? "50%" : "2px"};
        animation-delay: ${(Math.random() * 0.8).toFixed(2)}s;
        animation-duration: ${(Math.random() * 1.5 + 2.2).toFixed(2)}s;
        --drift: ${drift}px;
      `;
      wrap.appendChild(p);
    }

    setTimeout(() => wrap.remove(), 4200);
  }

  // ─── Override goTo to handle success population ───────────────
  const _goTo = goTo;
  function goToPublic(step) {
    if (step === 4) populateSuccess();
    _goTo(step);
    if (step === 4) triggerConfetti();
  }

  // ─── Bootstrap ────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", init);

  return {
    goTo: goToPublic,
    switchMode,
    reset,
    startRPD,
    cancelRPD,
    openUpiDrawer,
    closeUpiDrawer,
    openRpdDrawer,
    closeRpdDrawer,
    selectRpdApp,
    submitApplication,
  };
})();
