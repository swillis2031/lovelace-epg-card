const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
const html = LitElement.prototype.html;
const css = LitElement.prototype.css;

class EPGCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("epg-card-editor");
  }

  static getStubConfig() {
    return {
      entities: [],
      row_height: 100,

      // View options
      day_view: "both", // "today" | "tomorrow" | "both"
      start_mode: "now", // "now" | "midnight" | "fixed"
      start_time: "18:00", // used when start_mode === "fixed"

      // Window options
      hours_to_show: 4, // 2 | 4 | 8 | 12 | 18 | 24

      // Timeline tick interval
      timeline_interval: 60, // 30 | 60

      // UI
      show_controls: true,

      // Sticky header (controls + timeline) inside the card.
      sticky_header: true,

      // Use a real height so the card fills the view and can scroll internally
      card_height: "calc(100vh - 100px)",

      // Channel click script (passes variables.channel)
      channel_click_script: "script.media_remote_source_state_selector",

      // Logo fallback if entity_picture is missing or invalid
      channel_logo_base: "/local/channel_logos/svg/",
      channel_logo_ext: "svg",

      // Refresh control
      smart_refresh: true,
      now_tick_minutes: 1, // 1=every min, 5=every 5 min, 0=never auto-tick
    };
  }

  constructor() {
    super();
    this._hass = null;
    this._uiState = {
      day_view: null,
      start_mode: null,
      start_time: null,
      hours_to_show: null,
      window_start_min: null,
    };
    this.content = null;
    this.config = EPGCard.getStubConfig();

    // Smart refresh state
    this._lastEntitySignatures = new Map();
    this._lastTickKey = null;
    this._renderDebounce = null;
    this._debounceMs = 120;

    // Tooltip state (overlay)
    this._tooltipEl = null;
    this._tooltipHideTimer = null;
  }

  set hass(hass) {
    this._hass = hass;

    if (!this.content) {
      this.content = document.createElement("div");
      this.content.style.padding = "16px";
      this.appendChild(this.content);
    }

    // Stop re-rendering constantly
    if (this.config?.smart_refresh !== false) {
      if (!this._shouldRerender(hass)) return;

      clearTimeout(this._renderDebounce);
      this._renderDebounce = setTimeout(() => this._render(), this._debounceMs);
      return;
    }

    this._render();
  }

  setConfig(config) {
    if (!config.entities || !Array.isArray(config.entities) || config.entities.length === 0) {
      throw new Error("You need to define at least one entity.");
    }

    this.config = {
      ...EPGCard.getStubConfig(),
      ...config,
    };

    this._lastEntitySignatures.clear();
    this._lastTickKey = null;
    this._render();
  }

  getCardSize() {
    return 5;
  }

  _shouldRerender(hass) {
    const entityIds = this.config?.entities;
    if (!Array.isArray(entityIds) || entityIds.length === 0) return true;

    const tickEvery = Number(this.config?.now_tick_minutes ?? 1);
    if (tickEvery > 0) {
      const now = new Date();
      const minute = now.getMinutes();
      const bucket = Math.floor(minute / tickEvery) * tickEvery;
      const tickKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${bucket}`;
      if (this._lastTickKey !== tickKey) {
        this._lastTickKey = tickKey;
        return true;
      }
    }

    let changed = false;

    for (const entityId of entityIds) {
      const st = hass.states?.[entityId];
      if (!st) {
        if (this._lastEntitySignatures.has(entityId)) {
          this._lastEntitySignatures.delete(entityId);
          changed = true;
        }
        continue;
      }

      const today = st.attributes?.today;
      const tomorrow = st.attributes?.tomorrow;

      const sig =
        `${st.state}|${st.last_updated}|` +
        `${today && typeof today === "object" ? Object.keys(today).length : 0}|` +
        `${tomorrow && typeof tomorrow === "object" ? Object.keys(tomorrow).length : 0}`;

      const prev = this._lastEntitySignatures.get(entityId);
      if (prev !== sig) {
        this._lastEntitySignatures.set(entityId, sig);
        changed = true;
      }
    }

    return changed;
  }

  _renderImmediate() {
    clearTimeout(this._renderDebounce);
    this._render();
  }

  _render() {
    const hass = this._hass;
    if (!hass) return;

    const entityIds = this.config.entities;
    const row_height = this.config.row_height || 100;

    if (!entityIds || !Array.isArray(entityIds) || entityIds.length === 0) {
      this.content.innerHTML = `<b>Error:</b> No entities configured.`;
      return;
    }

    const day_view = this._uiState.day_view ?? this.config.day_view ?? "both";
    const start_mode = this._uiState.start_mode ?? this.config.start_mode ?? "now";
    const start_time = this._uiState.start_time ?? this.config.start_time ?? "18:00";
    const hours_to_show = this._normalizeHours(this._uiState.hours_to_show ?? this.config.hours_to_show ?? 4);
    const timeline_interval = this._normalizeInterval(this.config.timeline_interval ?? 60);
    const show_controls = this.config.show_controls !== false;

    const sticky_header = this.config.sticky_header !== false;
    const card_height = String(this.config.card_height ?? "calc(100vh - 100px)").trim();

    const { epgByDay, entityMap } = this._buildEpgByDay(hass, entityIds);
    const channels = Object.keys(entityMap);

    if (channels.length === 0) {
      this.content.innerHTML = `<b>Error:</b> None of the configured entities produced EPG data.`;
      return;
    }

    const window = this._computeWindow({
      day_view,
      start_mode,
      start_time,
      hours_to_show,
      timeline_interval,
    });

    const timeline = this._generateTimeline(window, timeline_interval);
    const tickCount = Math.max(1, timeline.length);
    const nowAxisMin = this._getNowAxisMinutes(day_view);

    const cardHeightCss =
      !card_height || card_height.toLowerCase() === "none"
        ? ""
        : `height: ${this._escapeAttr(card_height)};`;

    this.content.innerHTML = `
      <style>
        .epg-card {
          font-family: "Roboto", "Segoe UI", Arial, sans-serif;
          width: 100%;
          max-width: 100%;
          background-color: #f8f9fa;
          color: #202124;
          position: relative;
          overflow-x: hidden;
          overflow-y: ${sticky_header ? "auto" : "visible"};
          ${sticky_header ? cardHeightCss : ""}

          /* Keep layering predictable */
          isolation: isolate;

          --channel-col: 140px;
          --channel-link-w: 120px;
          --channel-link-h: 40px;
        }

       

        .epg-header {
          position: ${sticky_header ? "sticky" : "static"};
          top: 0;
          z-index: 2000;
          background: #f8f9fa;
          padding-bottom: 10px;
        }

        .epg-controls {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 10px;
          margin-bottom: 0;
          padding: 10px 12px;
          background: #f1f3f4;
          border: 1px solid #e0e0e0;
          border-radius: 10px;
          box-sizing: border-box;
        }

        .epg-controls .group { display: flex; align-items: center; gap: 8px; }
        .epg-controls .label { font-size: 12px; font-weight: 600; color: #3c4043; }

        .epg-btn {
          appearance: none;
          border: 1px solid #d2d6da;
          background: #ffffff;
          color: #202124;
          font-size: 12px;
          padding: 6px 10px;
          border-radius: 999px;
          cursor: pointer;
          box-shadow: 0 1px 1px rgba(60,64,67,0.10);
        }
        .epg-btn:hover { background: #f8f9fa; }
        .epg-btn.active { background: #e8f0fe; border-color: #d2e3fc; color: #174ea6; }

        .epg-select, .epg-time {
          border: 1px solid #d2d6da;
          background: #ffffff;
          color: #202124;
          font-size: 12px;
          padding: 6px 10px;
          border-radius: 10px;
          box-sizing: border-box;
        }
        .epg-time { padding: 5px 10px; }

        .timeline {
          display: grid;
          grid-template-columns: repeat(var(--tick-count), 1fr);
          margin-top: 10px;
          margin-left: var(--channel-col);
          background-color: #f1f3f4;
          border-bottom: 2px solid #cfd8dc;
          font-size: 13px;
          font-weight: 600;
          border-radius: 10px;
          overflow: hidden;
        }
        .timeline div {
          text-align: center;
          border-right: 1px solid #cfd8dc;
          padding: 8px 0;
          color: #3c4043;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .timeline div:last-child { border-right: none; }

        .epg-body { padding-top: 12px; }

        .channel-row {
          display: flex;
          align-items: stretch;
          height: ${row_height + 10}px;
          margin-bottom: 8px;
        }

        .channel-name {
          flex: 0 0 var(--channel-col);
          width: var(--channel-col);
          min-width: var(--channel-col);
          max-width: var(--channel-col);
          display: flex;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
          padding-right: 6px;
        }

        .channel-link {
          display: flex;
          align-items: center;
          justify-content: center;
          width: var(--channel-link-w);
          min-width: var(--channel-link-w);
          height: var(--channel-link-h);
          box-sizing: border-box;
          text-decoration: none;
          padding: 6px 10px;
          border-radius: 10px;
          overflow: hidden;
        }
        .channel-link:hover { background: rgba(26,115,232,0.08); }
        .channel-link:focus-visible { outline: 2px solid #1a73e8; outline-offset: 4px; }

        .channel-icon {
          display: block;
          max-width: 100%;
          max-height: 100%;
          width: auto;
          height: auto;
          object-fit: contain;
          flex: 0 0 auto;
          min-width: 1px;
          min-height: 1px;
        }

        .channel-fallback {
          display: none;
          font-size: 12px;
          font-weight: 600;
          color: #3c4043;
          max-width: 100%;
          text-align: center;
          line-height: 1.1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .channel-link.no-logo .channel-fallback { display: block; }

        .programs {
          flex: 1;
          position: relative;
          height: ${row_height}px;
          overflow: visible;
          padding-right: 2px;
          box-sizing: border-box;
          z-index: 0;
          background: rgba(255,255,255,0.7);
          border-radius: 10px;
          min-width: 0;
        }

        .program {
          position: absolute;
          height: ${row_height - 2}px;
          top: 2px;
          background-color: #e8f0fe;
          border: 1px solid #d2e3fc;
          color: #174ea6;
          border-radius: 8px;
          padding: 6px 8px;
          box-sizing: border-box;
          display: flex;
          align-items: flex-start;
          justify-content: flex-start;
          overflow: visible;
          cursor: pointer;
          font-size: 11px;
          line-height: 1.2;
          box-shadow: 0 1px 2px rgba(60,64,67,0.15);
          transition: background-color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
          z-index: 1;
        }

        .program-label {
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
          overflow: hidden;
          white-space: normal;
          word-break: break-word;
          min-width: 0;
          line-height: 1.2;
        }

        .program:hover {
          background-color: #d2e3fc;
          box-shadow: 0 4px 8px rgba(60,64,67,0.25);
          z-index: 2500; /* above sticky header */
        }

        .program.program-now {
          box-shadow: 0 3px 9px rgba(60,64,67,0.28);
          transform: translateY(-1px);
        }

        .program.program-live {
          background-color: #e6f4ea;
          border-color: #b7e1c1;
          color: #137333;
        }

        .program.program-live.program-now {
          background-color: #c9eed6;
          border-color: #7bd39a;
          color: #0d652d;
        }

        .program.program-live::before {
          content: "LIVE";
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 18px;
          padding: 0 7px;
          margin-right: 8px;
          background: #d93025;
          color: #ffffff;
          font-size: 9px;
          font-weight: 800;
          letter-spacing: 0.5px;
          border-radius: 999px;
          flex-shrink: 0;
          transform-origin: center;
          animation: livePulse 1.6s ease-in-out infinite;
        }

        .program.program-live.program-now::before {
          animation: livePulseStrong 1.2s ease-in-out infinite;
        }

        @keyframes livePulse {
          0%   { transform: scale(1);    box-shadow: 0 0 0 0 rgba(217,48,37,0.35); }
          65%  { transform: scale(1.06); box-shadow: 0 0 0 10px rgba(217,48,37,0); }
          100% { transform: scale(1);    box-shadow: 0 0 0 0 rgba(217,48,37,0); }
        }

        @keyframes livePulseStrong {
          0%   { transform: scale(1);    box-shadow: 0 0 0 0 rgba(217,48,37,0.45); }
          55%  { transform: scale(1.10); box-shadow: 0 0 0 14px rgba(217,48,37,0); }
          100% { transform: scale(1);    box-shadow: 0 0 0 0 rgba(217,48,37,0); }
        }

        @media (prefers-reduced-motion: reduce) {
          .program.program-live::before,
          .program.program-live.program-now::before {
            animation: none !important;
          }
        }

        /* NEW: real tooltip overlay element (not ::after) */
        .epg-tooltip {
          position: fixed;
          z-index: 6000;
          max-width: 360px;
          background: #202124;
          color: #e8eaed;
          padding: 10px 12px;
          border-radius: 10px;
          font-size: 11px;
          line-height: 1.25;
          white-space: pre-line;
          box-shadow: 0 8px 20px rgba(0,0,0,0.30);
          pointer-events: none;
          opacity: 0;
          transform: translateY(4px);
          transition: opacity 0.10s ease, transform 0.10s ease;
        }
        .epg-tooltip.show {
          opacity: 1;
          transform: translateY(0);
        }
      </style>

      <div class="epg-card" style="--tick-count:${tickCount};">
        <div class="epg-header">
          ${show_controls ? this._renderControlsHtml({ day_view, start_mode, start_time, hours_to_show }) : ""}
          <div class="timeline" title="Window: ${this._formatWindowLabel(day_view, window)}">
            ${timeline.map((time) => `<div>${time}</div>`).join("")}
          </div>
        </div>

        <div class="epg-body">
          ${channels
            .map((channel) => {
              const entity = entityMap[channel];
              const logoUrl = this._getChannelLogoUrl(entity, channel);
              const programsForView = this._getProgramsForView(epgByDay, channel, day_view);
              const linkClass = logoUrl ? "channel-link" : "channel-link no-logo";

              return `
                <div class="channel-row">
                  <div class="channel-name">
                    <a href="#"
                       class="${linkClass}"
                       data-channel="${this._escapeAttr(channel)}"
                       aria-label="Select ${this._escapeAttr(channel)}">

                      ${logoUrl ? `<img src="${this._escapeAttr(logoUrl)}" class="channel-icon"/>` : ""}
                      <span class="channel-fallback">${this._escapeHtml(channel)}</span>
                    </a>
                  </div>

                  <div class="programs">
                    ${this._renderPrograms(programsForView, window, day_view, nowAxisMin)}
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>

      <!-- NEW: tooltip overlay node -->
      <div class="epg-tooltip" hidden></div>
    `;

    if (show_controls) {
      this._wireControls(timeline_interval);
    } else {
      // Still wire program tooltips if controls are off
      this._wireProgramTooltips();
    }
  }

  _renderControlsHtml({ day_view, start_mode, start_time, hours_to_show }) {
    return `
      <div class="epg-controls">
        <div class="group">
          <span class="label">Day</span>
          <button class="epg-btn js-day ${day_view === "today" ? "active" : ""}" data-day="today">Today</button>
          <button class="epg-btn js-day ${day_view === "tomorrow" ? "active" : ""}" data-day="tomorrow">Tomorrow</button>
          <button class="epg-btn js-day ${day_view === "both" ? "active" : ""}" data-day="both">2-Day</button>
        </div>

        <div class="group">
          <span class="label">Start</span>
          <select class="epg-select js-startmode">
            <option value="now"      ${start_mode === "now" ? "selected" : ""}>Now</option>
            <option value="midnight" ${start_mode === "midnight" ? "selected" : ""}>Midnight</option>
            <option value="fixed"    ${start_mode === "fixed" ? "selected" : ""}>Fixed</option>
          </select>
          <input class="epg-time js-starttime" type="time" value="${this._escapeAttr(start_time)}" ${
            start_mode === "fixed" ? "" : 'style="display:none"'
          } />
        </div>

        <div class="group">
          <span class="label">Window</span>
          <select class="epg-select js-hours">
            ${[2, 4, 8, 12, 18, 24]
              .map((h) => `<option value="${h}" ${Number(hours_to_show) === h ? "selected" : ""}>${h}h</option>`)
              .join("")}
          </select>
        </div>

        <div class="group">
          <span class="label">Shift</span>
          <button class="epg-btn js-shift" data-dir="-1" title="Back by window">◀</button>
          <button class="epg-btn js-shift" data-dir="1"  title="Forward by window">▶</button>
        </div>
      </div>
    `;
  }

  _wireControls(timeline_interval) {
    const root = this.content;
    if (!root) return;

    const dayButtons = root.querySelectorAll(".js-day");
    const startModeSel = root.querySelector(".js-startmode");
    const startTimeInp = root.querySelector(".js-starttime");
    const hoursSel = root.querySelector(".js-hours");
    const shiftButtons = root.querySelectorAll(".js-shift");

    dayButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        this._uiState.day_view = btn.getAttribute("data-day");
        this._uiState.window_start_min = null;
        this._renderImmediate();
      });
    });

    if (startModeSel) {
      startModeSel.addEventListener("change", (ev) => {
        this._uiState.start_mode = ev.target.value;
        this._uiState.window_start_min = null;
        this._renderImmediate();
      });
    }

    if (startTimeInp) {
      startTimeInp.addEventListener("change", (ev) => {
        this._uiState.start_time = ev.target.value || "00:00";
        this._uiState.window_start_min = null;
        this._renderImmediate();
      });
    }

    if (hoursSel) {
      hoursSel.addEventListener("change", (ev) => {
        this._uiState.hours_to_show = Number(ev.target.value);
        this._uiState.window_start_min = null;
        this._renderImmediate();
      });
    }

    shiftButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const dir = Number(btn.getAttribute("data-dir") || "0");

        const effectiveDayView = this._uiState.day_view ?? this.config.day_view ?? "both";
        const start_mode = this._uiState.start_mode ?? this.config.start_mode ?? "now";
        const start_time = this._uiState.start_time ?? this.config.start_time ?? "18:00";
        const hours_to_show = this._normalizeHours(this._uiState.hours_to_show ?? this.config.hours_to_show ?? 4);

        const window = this._computeWindow({
          day_view: effectiveDayView,
          start_mode,
          start_time,
          hours_to_show,
          timeline_interval,
        });

        const delta = dir * window.totalMin;
        const bounds = this._viewBounds(effectiveDayView);
        const newStart = window.startMin + delta;
        const clamped = Math.max(bounds.min, Math.min(bounds.max - window.totalMin, newStart));

        this._uiState.window_start_min = clamped;
        this._renderImmediate();
      });
    });

    root.querySelectorAll(".channel-link").forEach((a) => {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const scriptEntity = this.config.channel_click_script;
        if (!scriptEntity || typeof scriptEntity !== "string") return;

        const channelName = a.getAttribute("data-channel") || "";

        this._hass.callService("script", "turn_on", {
          entity_id: scriptEntity,
          variables: { channel: channelName },
        });
      });
    });

    root.querySelectorAll(".channel-icon").forEach((img) => {
      img.addEventListener("error", () => {
        const link = img.closest(".channel-link");
        if (link) link.classList.add("no-logo");
        img.style.display = "none";
      });
    });

    // NEW: wire tooltips after render
    this._wireProgramTooltips();
  }

  // NEW: robust tooltip overlay wiring
  _wireProgramTooltips() {
    const root = this.content;
    if (!root) return;

    const tooltip = root.querySelector(".epg-tooltip");
    this._tooltipEl = tooltip || null;
    if (!this._tooltipEl) return;

    const hide = () => {
      if (!this._tooltipEl) return;
      this._tooltipEl.classList.remove("show");
      this._tooltipEl.hidden = true;
    };

    const show = (text, anchorRect) => {
      if (!this._tooltipEl) return;
      if (!text) {
        hide();
        return;
      }

      this._tooltipEl.textContent = text;
      this._tooltipEl.hidden = false;

      // First show so we can measure
      this._tooltipEl.classList.add("show");

      const ttRect = this._tooltipEl.getBoundingClientRect();
      const margin = 10;

      // Prefer above the program; if not enough room, place below
      let x = anchorRect.left;
      let y = anchorRect.top - ttRect.height - 8;

      if (y < margin) {
        y = anchorRect.bottom + 8;
      }

      // Clamp horizontally
      x = Math.max(margin, Math.min(x, window.innerWidth - ttRect.width - margin));

      this._tooltipEl.style.left = `${Math.round(x)}px`;
      this._tooltipEl.style.top = `${Math.round(y)}px`;
    };

    // Clean previous listeners by re-binding fresh each render
    root.querySelectorAll(".program").forEach((el) => {
      el.addEventListener("mouseenter", () => {
        clearTimeout(this._tooltipHideTimer);
        const text = el.getAttribute("data-tooltip") || "";
        show(text, el.getBoundingClientRect());
      });

      el.addEventListener("mousemove", () => {
        // Keep tooltip anchored to the element (not the cursor) to avoid jitter
        clearTimeout(this._tooltipHideTimer);
        const text = el.getAttribute("data-tooltip") || "";
        show(text, el.getBoundingClientRect());
      });

      el.addEventListener("mouseleave", () => {
        clearTimeout(this._tooltipHideTimer);
        this._tooltipHideTimer = setTimeout(hide, 40);
      });
    });

    // Hide tooltip on scroll inside card (prevents “stale” tooltip position)
    const scroller = root.querySelector(".epg-card");
    if (scroller) {
      scroller.addEventListener("scroll", hide, { passive: true });
    }

    // Hide tooltip if mouse leaves the card entirely
    const card = root.querySelector(".epg-card");
    if (card) {
      card.addEventListener("mouseleave", hide);
    }
  }

  _renderPrograms(programs, window, day_view, nowAxisMin) {
    const htmlParts = [];

    for (const p of programs) {
      const overlap = this._overlapSegment(p.startMin, p.endMin, window.startMin, window.endMin);
      if (!overlap) continue;

      const leftPct = ((overlap.start - window.startMin) / window.totalMin) * 100;
      const widthPct = ((overlap.end - overlap.start) / window.totalMin) * 100;

      const durationMin = Math.max(0, Math.round(p.endMin - p.startMin));
      const startLabel = this._formatTimeFromViewMinutes(p.startMin, day_view);
      const endLabel = this._formatTimeFromViewMinutes(p.endMin, day_view);

      const tooltipText = [p.title || "", p.desc || "", `${startLabel}–${endLabel} (${durationMin} min)`]
        .filter(Boolean)
        .join("\n");

      const titleTrimmed = String(p.title || "").trim();
      const isLive = /^live/i.test(titleTrimmed);
      const isNow = typeof nowAxisMin === "number" && nowAxisMin >= p.startMin && nowAxisMin < p.endMin;

      const classes = ["program"];
      if (isLive) classes.push("program-live");
      if (isNow) classes.push("program-now");

      htmlParts.push(`
        <div class="${classes.join(" ")}"
          data-tooltip="${this._escapeAttr(tooltipText)}"
          style="left:${leftPct}%; width:${widthPct}%;">
          <span class="program-label">${this._escapeHtml(p.title)}</span>
        </div>
      `);
    }

    return htmlParts.join("");
  }

  _buildEpgByDay(hass, entityIds) {
    const epgByDay = { today: {}, tomorrow: {} };
    const entityMap = {};

    entityIds.forEach((entityId) => {
      const state = hass.states[entityId];
      if (!state) return;

      const friendlyName = state.attributes.friendly_name || entityId;
      entityMap[friendlyName] = state;

      const todayPrograms = state.attributes?.today;
      epgByDay.today[friendlyName] =
        todayPrograms && typeof todayPrograms === "object" ? this._normalizePrograms(todayPrograms, 0) : [];

      const tomorrowPrograms = state.attributes?.tomorrow;
      epgByDay.tomorrow[friendlyName] =
        tomorrowPrograms && typeof tomorrowPrograms === "object" ? this._normalizePrograms(tomorrowPrograms, 1440) : [];
    });

    return { epgByDay, entityMap };
  }

  _normalizePrograms(programsObj, dayOffsetMin) {
    const keys = Object.keys(programsObj || {}).sort();
    const result = [];

    for (let i = 0; i < keys.length; i++) {
      const startStr = keys[i];
      const program = programsObj[startStr] || {};
      const endStr = i === keys.length - 1 ? "24:00" : keys[i + 1];

      const startMin = this._convertTimeToMinutes(startStr) + dayOffsetMin;
      let endMin = this._convertTimeToMinutes(endStr) + dayOffsetMin;

      if (endMin < startMin) endMin += 1440;

      result.push({
        title: program.title ?? "",
        desc: program.desc ?? "",
        startMin,
        endMin,
      });
    }

    return result;
  }

  _getProgramsForView(epgByDay, channel, day_view) {
    if (day_view === "today") return epgByDay.today[channel] || [];
    if (day_view === "tomorrow") return epgByDay.tomorrow[channel] || [];
    return (epgByDay.today[channel] || []).concat(epgByDay.tomorrow[channel] || []);
  }

  _computeWindow({ day_view, start_mode, start_time, hours_to_show, timeline_interval }) {
    const bounds = this._viewBounds(day_view);
    const totalMin = Math.max(60, Math.min(hours_to_show * 60, bounds.max - bounds.min));
    const interval = this._normalizeInterval(timeline_interval ?? 60);

    if (typeof this._uiState.window_start_min === "number") {
      const startMin = this._clamp(this._uiState.window_start_min, bounds.min, bounds.max - totalMin);
      return { startMin, endMin: startMin + totalMin, totalMin };
    }

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    let startMin;

    if (start_mode === "fixed") {
      const fixed = this._convertTimeToMinutes(start_time);
      const dayBase = day_view === "tomorrow" ? 1440 : 0;
      startMin = dayBase + fixed;
      startMin = startMin - (startMin % interval);
    } else if (start_mode === "midnight") {
      startMin = bounds.min;
    } else {
      startMin = day_view === "tomorrow" ? 1440 + nowMin : nowMin;
      startMin = startMin - (startMin % interval);
    }

    startMin = this._clamp(startMin, bounds.min, bounds.max - totalMin);
    return { startMin, endMin: startMin + totalMin, totalMin };
  }

  _viewBounds(day_view) {
    if (day_view === "tomorrow") return { min: 1440, max: 4320 };
    if (day_view === "both") return { min: 0, max: 2880 };
    return { min: 0, max: 2880 };
  }

  _generateTimeline(window, intervalMin) {
    const totalMin = window.totalMin;
    const ticksCount = Math.max(1, Math.round(totalMin / intervalMin));
    const alignedStart = window.startMin - (window.startMin % intervalMin);

    const ticks = [];
    for (let i = 0; i < ticksCount; i++) {
      const t = alignedStart + i * intervalMin;
      const minutesIntoDay = ((t % 1440) + 1440) % 1440;
      const hh = String(Math.floor(minutesIntoDay / 60)).padStart(2, "0");
      const mm = String(minutesIntoDay % 60).padStart(2, "0");
      ticks.push(intervalMin === 60 ? `${hh}:00` : `${hh}:${mm}`);
    }
    return ticks;
  }

  _overlapSegment(aStart, aEnd, bStart, bEnd) {
    const start = Math.max(aStart, bStart);
    const end = Math.min(aEnd, bEnd);
    if (end <= start) return null;
    return { start, end };
  }

  _formatTimeFromViewMinutes(viewMin, day_view) {
    const minutesIntoDay = ((viewMin % 1440) + 1440) % 1440;
    const hh = String(Math.floor(minutesIntoDay / 60)).padStart(2, "0");
    const mm = String(minutesIntoDay % 60).padStart(2, "0");

    if (day_view === "both") {
      const dayLabel = viewMin >= 1440 ? "Tomorrow" : "Today";
      return `${dayLabel} ${hh}:${mm}`;
    }

    if (day_view === "today" && viewMin >= 1440) return `Tomorrow ${hh}:${mm}`;
    if (day_view === "tomorrow" && viewMin >= 2880) return `Next ${hh}:${mm}`;
    return `${hh}:${mm}`;
  }

  _formatWindowLabel(day_view, window) {
    const start = this._formatTimeFromViewMinutes(window.startMin, day_view);
    const end = this._formatTimeFromViewMinutes(window.endMin, day_view);
    return `${start}–${end}`;
  }

  _getNowAxisMinutes(day_view) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (day_view === "tomorrow") return 1440 + nowMin;
    return nowMin;
  }

  _normalizeHours(h) {
    const allowed = new Set([2, 4, 8, 12, 18, 24]);
    const n = Number(h);
    return allowed.has(n) ? n : 4;
  }

  _normalizeInterval(i) {
    const n = Number(i);
    return n === 30 ? 30 : 60;
  }

  _convertTimeToMinutes(time) {
    const [hoursStr, minutesStr] = String(time).split(":");
    const hours = parseInt(hoursStr, 10);
    const minutes = parseInt(minutesStr, 10);
    return hours * 60 + minutes;
  }

  _clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  _escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  _escapeAttr(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  _sanitizeLogoFile(name) {
    return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  _normalizeEntityPictureUrl(pic) {
    const p = String(pic || "").trim();
    if (!p) return "";

    if (/^(https?:)?\/\//i.test(p)) return p;
    if (p.startsWith("/")) return p;
    if (p.startsWith("local/")) return `/${p}`;

    return p;
  }

  _getChannelLogoUrl(entity, channelName) {
    const picRaw = entity?.attributes?.entity_picture;
    const pic = this._normalizeEntityPictureUrl(picRaw);
    if (pic) return pic;

    const base = (this.config.channel_logo_base || "").trim();
    if (!base) return "";

    const ext = (this.config.channel_logo_ext || "png").trim().replace(/^\./, "");
    const file = this._sanitizeLogoFile(channelName);
    if (!file) return "";

    const baseFixed = base.endsWith("/") ? base : `${base}/`;
    return `${baseFixed}${file}.${ext}`;
  }
}

customElements.define("epg-card", EPGCard);

class EPGCardEditor extends LitElement {
  static get properties() {
    return {
      hass: { type: Object },
      config: { type: Object },
    };
  }

  constructor() {
    super();
    this.config = {};
  }

  static get styles() {
    return css`
      :host {
        display: block;
        padding: 16px;
      }
    `;
  }

  setConfig(config) {
    this.config = config;
  }

  _valueChanged(ev) {
    const newValue = ev.detail.value;
    this.config = { ...this.config, ...newValue };
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this.config } }));
  }

  render() {
    return html`
      <ha-form
        .hass=${this.hass}
        .data=${this.config}
        .schema=${[
          { name: "row_height", selector: { number: { min: 50, max: 300, unit: "px", default: 100 } }, default: 100 },
          {
            name: "day_view",
            selector: { select: { options: [
              { value: "today", label: "Today" },
              { value: "tomorrow", label: "Tomorrow" },
              { value: "both", label: "2-Day (Today + Tomorrow)" },
            ] } },
            default: "both",
          },
          {
            name: "start_mode",
            selector: { select: { options: [
              { value: "now", label: "Now" },
              { value: "midnight", label: "Midnight" },
              { value: "fixed", label: "Fixed time" },
            ] } },
            default: "now",
          },
          { name: "start_time", selector: { text: {} }, default: "18:00" },
          {
            name: "hours_to_show",
            selector: { select: { options: [
              { value: 2, label: "2 hours" },
              { value: 4, label: "4 hours" },
              { value: 8, label: "8 hours" },
              { value: 12, label: "12 hours" },
              { value: 18, label: "18 hours" },
              { value: 24, label: "24 hours" },
            ] } },
            default: 4,
          },
          {
            name: "timeline_interval",
            selector: { select: { options: [
              { value: 60, label: "60 min ticks" },
              { value: 30, label: "30 min ticks" },
            ] } },
            default: 60,
          },
          { name: "show_controls", selector: { boolean: {} }, default: true },
          { name: "sticky_header", selector: { boolean: {} }, default: true },
          { name: "card_height", selector: { text: {} }, default: "calc(100vh - 100px)" },
          { name: "channel_click_script", selector: { entity: { domain: "script" } } },
          { name: "channel_logo_base", selector: { text: {} } },
          { name: "channel_logo_ext", selector: { text: {} } },
          { name: "smart_refresh", selector: { boolean: {} }, default: true },
          { name: "now_tick_minutes", selector: { number: { min: 0, max: 30, step: 1, unit: "min", mode: "box" } }, default: 1 },
          { name: "entities", selector: { entity: { domain: "sensor", multiple: true, integration: "epg" } } },
        ]}
        @value-changed=${this._valueChanged}
      ></ha-form>
    `;
  }
}

customElements.define("epg-card-editor", EPGCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "epg-card",
  name: "EPG Card",
  preview: false,
  description:
    "HomeAssistant EPG card (sticky header, smart refresh, LIVE pill + now highlight, channel logo click calls script with channel variable, robust tooltip overlay).",
  documentationURL: "https://github.com/yohaybn/lovelace-epg-card",
});
