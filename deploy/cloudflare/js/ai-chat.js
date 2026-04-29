/* AI assistant mixin: streaming chat-completions with tool-calling. */
(function () {
    'use strict';

    function renderMarkdown(text) {
        if (!text) return '';
        try {
            var html = window.marked.parse(text, { gfm: true, breaks: true });
            return window.DOMPurify.sanitize(html);
        } catch (e) {
            return window.DOMPurify
                ? window.DOMPurify.sanitize(text)
                : text.replace(/[&<>]/g, function (c) {
                    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
                });
        }
    }

    // ----- Tool definitions (OpenAI tool-calling spec) -----
    var TOOL_DEFS = [
        {
            type: 'function',
            function: {
                name: 'select_object',
                description: 'Select and center the planetarium view on a celestial object (star, planet, constellation, deep-sky object, etc.) by its common name or catalogue id.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'e.g. "Sirius", "M31", "Orion", "NAME Vega"' }
                    },
                    required: ['name']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'get_selection',
                description: 'Return information about the currently selected celestial object, if any.',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'unselect',
                description: 'Clear the current celestial-object selection.',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'set_time',
                description: 'Set the planetarium clock to a given UTC ISO 8601 timestamp.',
                parameters: {
                    type: 'object',
                    properties: {
                        iso: { type: 'string', description: 'UTC ISO 8601 timestamp, e.g. "2025-08-12T22:00:00Z".' }
                    },
                    required: ['iso']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'advance_time',
                description: 'Advance (or rewind, with negative values) the planetarium clock by an offset.',
                parameters: {
                    type: 'object',
                    properties: {
                        days: { type: 'number', description: 'Days to add (can be fractional, can be negative).' },
                        hours: { type: 'number', description: 'Hours to add (can be fractional, can be negative).' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'reset_time',
                description: 'Reset the planetarium clock to the real wall-clock time (now).',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'get_observer',
                description: 'Return the observer location (latitude, longitude in degrees; elevation in m) and current UTC time.',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'set_observer_location',
                description: 'Move the observer to a given latitude/longitude on Earth (degrees).',
                parameters: {
                    type: 'object',
                    properties: {
                        latitude: { type: 'number', description: 'Latitude in degrees, -90..90.' },
                        longitude: { type: 'number', description: 'Longitude in degrees, -180..180.' },
                        elevation: { type: 'number', description: 'Elevation in metres (optional).' }
                    },
                    required: ['latitude', 'longitude']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'set_layer',
                description: 'Toggle a visual layer on or off. Layers: "constellations", "constellation_lines", "constellation_art", "atmosphere", "landscape", "azimuthal_grid", "equatorial_grid", "dsos" (nebulae), "dss", "milkyway", "satellites".',
                parameters: {
                    type: 'object',
                    properties: {
                        layer: { type: 'string' },
                        visible: { type: 'boolean' }
                    },
                    required: ['layer', 'visible']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'set_fov',
                description: 'Set the field of view in degrees (zoom). Smaller = more zoomed in. Reasonable range 0.1 to 180.',
                parameters: {
                    type: 'object',
                    properties: {
                        degrees: { type: 'number' }
                    },
                    required: ['degrees']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'point_at',
                description: 'Point the camera at a given equatorial Right Ascension / Declination (degrees) without selecting any object.',
                parameters: {
                    type: 'object',
                    properties: {
                        ra: { type: 'number', description: 'Right Ascension in degrees, 0..360.' },
                        dec: { type: 'number', description: 'Declination in degrees, -90..90.' }
                    },
                    required: ['ra', 'dec']
                }
            }
        }
    ];

    window.AiChatMixin = {
        data: function () {
            return {
                aiOpen: false,
                aiBusy: false,
                aiInput: '',
                aiMessages: [],
                aiAbort: null,
                llmBaseUrl: '',
                llmApiKey: '',
                llmModel: '',
                llmSaved: false
            };
        },
        computed: {
            visibleMessages: function () {
                var roleLabels = {
                    user: this.t('ai.role.user'),
                    assistant: this.t('ai.role.assistant'),
                    tool: this.t('ai.role.tool'),
                    system: this.t('ai.role.system')
                };
                var out = [];
                for (var i = 0; i < this.aiMessages.length; i++) {
                    var m = this.aiMessages[i];
                    if (m.role === 'system') continue;
                    // Hide assistant turns whose only purpose was to issue tool_calls.
                    if (m.role === 'assistant' && !m.content && m.tool_calls) continue;
                    if (m.role === 'tool') {
                        out.push({
                            role: 'tool',
                            roleLabel: this.t('ai.toolDone', { name: m.name || 'tool' }),
                            content: m.content || '',
                            html: '',
                            isAssistant: false,
                            streaming: false
                        });
                        continue;
                    }
                    out.push({
                        role: m.role,
                        roleLabel: roleLabels[m.role] || m.role,
                        content: m.content || '',
                        html: m.role === 'assistant' ? renderMarkdown(m.content || '') : '',
                        isAssistant: m.role === 'assistant',
                        streaming: !!m.streaming
                    });
                }
                return out;
            }
        },
        methods: {
            // ----- Settings persistence -----
            saveLlmSettings: function () {
                try {
                    localStorage.setItem('stelweb.llm.baseUrl', this.llmBaseUrl || '');
                    localStorage.setItem('stelweb.llm.apiKey', this.llmApiKey || '');
                    localStorage.setItem('stelweb.llm.model', this.llmModel || '');
                } catch (e) { /* ignore */ }
                var that = this;
                this.llmSaved = true;
                setTimeout(function () { that.llmSaved = false; }, 2000);
            },
            restoreLlmSettings: function () {
                try {
                    this.llmBaseUrl = localStorage.getItem('stelweb.llm.baseUrl') || '';
                    this.llmApiKey = localStorage.getItem('stelweb.llm.apiKey') || '';
                    this.llmModel = localStorage.getItem('stelweb.llm.model') || '';
                } catch (e) { /* ignore */ }
            },

            // ----- UI actions -----
            clearChat: function () {
                this.stopChat();
                this.aiMessages = [];
            },
            stopChat: function () {
                if (this.aiAbort) {
                    try { this.aiAbort.abort(); } catch (e) { /* ignore */ }
                    this.aiAbort = null;
                }
            },
            insertSelectionContext: function () {
                var sel = this.stel && this.stel.core.selection;
                if (!sel) return;
                var name = (sel.designations()[0] || '').replace(/^NAME /, '');
                this.aiInput = (this.aiInput ? this.aiInput.trim() + ' ' : '') +
                    this.t('ai.aboutPrefix', { name: name });
            },

            // ----- Tool implementations -----
            _aiSelectObject: function (name) {
                if (!name || !this.stel) return { ok: false, error: 'no name' };
                var stel = this.stel;
                var raw = String(name).trim();
                var bare = raw.replace(/^NAME\s+/i, '').trim();
                var titled = bare.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
                var seen = Object.create(null);
                var candidates = [];
                [bare, 'NAME ' + bare, bare.toUpperCase(), 'NAME ' + bare.toUpperCase(),
                 titled, 'NAME ' + titled, raw].forEach(function (c) {
                    if (c && !seen[c]) { seen[c] = 1; candidates.push(c); }
                });
                var obj = null;
                for (var i = 0; i < candidates.length; i++) {
                    obj = stel.getObj(candidates[i]);
                    if (obj) break;
                }
                if (!obj) return { ok: false, error: 'not found: ' + name };
                stel.core.selection = obj;
                try { stel.pointAndLock(obj, 0.8); } catch (e) { /* ignore */ }
                // Zoom in so the target is clearly framed. Pick a target FOV
                // based on object type; only zoom in (never out), so users who
                // already zoomed past the default keep their framing.
                try {
                    var designationsForType = obj.designations() || [];
                    var firstDes = (designationsForType[0] || '').toUpperCase();
                    var targetFovDeg = 10; // default for stars / planets / small DSOs
                    if (/^CON\s|^NAME\s.*(CONSTELLATION)?$/i.test(firstDes) ||
                        designationsForType.some(function (d) { return /^CON\s/i.test(d); })) {
                        targetFovDeg = 40; // constellations need a wider frame
                    } else if (/^M\s?\d+|NGC|IC\s|\bGALAXY\b|NEBULA/i.test(firstDes)) {
                        targetFovDeg = 6;  // deep-sky: tighter frame
                    } else if (/SUN|MOON|MERCURY|VENUS|MARS|JUPITER|SATURN|URANUS|NEPTUNE/i.test(firstDes)) {
                        targetFovDeg = 4;  // planets / sun / moon: tight
                    }
                    var targetFov = targetFovDeg * Math.PI / 180;
                    var curFov = stel.core.fov;
                    if (curFov > targetFov) {
                        // Smooth tween over ~0.8s using requestAnimationFrame.
                        var t0 = performance.now();
                        var dur = 800;
                        var from = curFov;
                        var step = function (now) {
                            var k = Math.min(1, (now - t0) / dur);
                            // ease-out cubic
                            var e = 1 - Math.pow(1 - k, 3);
                            stel.core.fov = from + (targetFov - from) * e;
                            if (k < 1) requestAnimationFrame(step);
                        };
                        requestAnimationFrame(step);
                    }
                } catch (e) { /* ignore */ }
                var designations = obj.designations() || [];
                var info = { ok: true, name: name, designations: designations };
                try {
                    var v = obj.getInfo('vmag');
                    if (v !== undefined) info.vmag = Number(v.toFixed(2));
                } catch (e) { /* ignore */ }
                return info;
            },
            _aiGetSelection: function () {
                var sel = this.stel && this.stel.core.selection;
                if (!sel) return { selected: false };
                var designations = sel.designations() || [];
                var out = { selected: true, designations: designations };
                try {
                    var v = sel.getInfo('vmag');
                    if (v !== undefined) out.vmag = Number(v.toFixed(2));
                } catch (e) { /* ignore */ }
                try {
                    var d = sel.getInfo('distance');
                    if (d !== undefined && d > 0) out.distanceAU = d;
                } catch (e) { /* ignore */ }
                return out;
            },
            _aiSetTime: function (iso) {
                if (!this.stel || !iso) return { ok: false, error: 'invalid' };
                var d = new Date(iso);
                if (isNaN(d.getTime())) return { ok: false, error: 'bad date' };
                var mjd = d.getTime() / 86400000 + 40587;
                try {
                    this.stel.core.observer.utc = mjd;
                    return { ok: true, utc: d.toISOString() };
                } catch (e) {
                    return { ok: false, error: String(e) };
                }
            },
            _aiAdvanceTime: function (days, hours) {
                if (!this.stel) return { ok: false, error: 'engine not ready' };
                var delta = (Number(days) || 0) + (Number(hours) || 0) / 24;
                if (!isFinite(delta)) return { ok: false, error: 'bad delta' };
                try {
                    var obs = this.stel.core.observer;
                    obs.utc = obs.utc + delta;
                    return { ok: true, utc: new Date((obs.utc - 40587) * 86400000).toISOString() };
                } catch (e) { return { ok: false, error: String(e) }; }
            },
            _aiResetTime: function () {
                if (!this.stel) return { ok: false, error: 'engine not ready' };
                try {
                    var mjd = Date.now() / 86400000 + 40587;
                    this.stel.core.observer.utc = mjd;
                    return { ok: true, utc: new Date().toISOString() };
                } catch (e) { return { ok: false, error: String(e) }; }
            },
            _aiUnselect: function () {
                if (!this.stel) return { ok: false, error: 'engine not ready' };
                try { this.stel.core.selection = null; return { ok: true }; }
                catch (e) { return { ok: false, error: String(e) }; }
            },
            _aiGetObserver: function () {
                if (!this.stel) return { ok: false, error: 'engine not ready' };
                var obs = this.stel.core.observer;
                return {
                    ok: true,
                    latitude: Number((obs.latitude * 180 / Math.PI).toFixed(4)),
                    longitude: Number((obs.longitude * 180 / Math.PI).toFixed(4)),
                    elevation: obs.elevation,
                    utc: new Date((obs.utc - 40587) * 86400000).toISOString()
                };
            },
            _aiSetObserverLocation: function (lat, lng, elev) {
                if (!this.stel) return { ok: false, error: 'engine not ready' };
                if (typeof lat !== 'number' || typeof lng !== 'number') {
                    return { ok: false, error: 'latitude/longitude must be numbers' };
                }
                if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
                    return { ok: false, error: 'out of range' };
                }
                try {
                    var obs = this.stel.core.observer;
                    obs.latitude = lat * Math.PI / 180;
                    obs.longitude = lng * Math.PI / 180;
                    if (typeof elev === 'number') obs.elevation = elev;
                    return { ok: true, latitude: lat, longitude: lng };
                } catch (e) { return { ok: false, error: String(e) }; }
            },
            _aiSetLayer: function (layer, visible) {
                if (!this.stel) return { ok: false, error: 'engine not ready' };
                var core = this.stel.core;
                var v = !!visible;
                var map = {
                    'constellations': function () { core.constellations.lines_visible = v; },
                    'constellation_lines': function () { core.constellations.lines_visible = v; },
                    'constellation_art': function () { core.constellations.images_visible = v; },
                    'atmosphere': function () { core.atmosphere.visible = v; },
                    'landscape': function () { core.landscapes.visible = v; },
                    'azimuthal_grid': function () { core.lines.azimuthal.visible = v; },
                    'equatorial_grid': function () { core.lines.equatorial.visible = v; },
                    'dsos': function () { core.dsos.visible = v; },
                    'nebulae': function () { core.dsos.visible = v; },
                    'dss': function () { core.dss.visible = v; },
                    'milkyway': function () { core.milkyway.visible = v; },
                    'satellites': function () { if (core.satellites) core.satellites.visible = v; }
                };
                var fn = map[String(layer || '').toLowerCase()];
                if (!fn) return { ok: false, error: 'unknown layer: ' + layer };
                try { fn(); return { ok: true, layer: layer, visible: v }; }
                catch (e) { return { ok: false, error: String(e) }; }
            },
            _aiSetFov: function (deg) {
                if (!this.stel) return { ok: false, error: 'engine not ready' };
                var d = Number(deg);
                if (!isFinite(d) || d <= 0 || d > 360) return { ok: false, error: 'bad fov' };
                try {
                    this.stel.core.fov = d * Math.PI / 180;
                    return { ok: true, fov_deg: d };
                } catch (e) { return { ok: false, error: String(e) }; }
            },
            _aiPointAt: function (raDeg, decDeg) {
                if (!this.stel) return { ok: false, error: 'engine not ready' };
                if (typeof raDeg !== 'number' || typeof decDeg !== 'number') {
                    return { ok: false, error: 'ra/dec must be numbers' };
                }
                try {
                    var ra = raDeg * Math.PI / 180;
                    var dec = decDeg * Math.PI / 180;
                    var x = Math.cos(dec) * Math.cos(ra);
                    var y = Math.cos(dec) * Math.sin(ra);
                    var z = Math.sin(dec);
                    this.stel.pointAndLock([x, y, z], 0.8);
                    return { ok: true, ra: raDeg, dec: decDeg };
                } catch (e) { return { ok: false, error: String(e) }; }
            },
            _aiRunTool: function (name, argsJson) {
                var args = {};
                try { args = JSON.parse(argsJson || '{}'); } catch (e) { /* ignore */ }
                switch (name) {
                    case 'select_object': return this._aiSelectObject(args.name);
                    case 'get_selection': return this._aiGetSelection();
                    case 'unselect': return this._aiUnselect();
                    case 'set_time': return this._aiSetTime(args.iso);
                    case 'advance_time': return this._aiAdvanceTime(args.days, args.hours);
                    case 'reset_time': return this._aiResetTime();
                    case 'get_observer': return this._aiGetObserver();
                    case 'set_observer_location':
                        return this._aiSetObserverLocation(args.latitude, args.longitude, args.elevation);
                    case 'set_layer': return this._aiSetLayer(args.layer, args.visible);
                    case 'set_fov': return this._aiSetFov(args.degrees);
                    case 'point_at': return this._aiPointAt(args.ra, args.dec);
                    default: return { ok: false, error: 'unknown tool: ' + name };
                }
            },

            // ----- Conversation -----
            sendChat: function () {
                var text = (this.aiInput || '').trim();
                if (!text || this.aiBusy) return;
                if (!this.llmBaseUrl || !this.llmApiKey || !this.llmModel) {
                    this.aiMessages.push({ role: 'assistant', content: this.t('ai.needSettings') });
                    return;
                }
                this.aiInput = '';
                this.aiMessages.push({ role: 'user', content: text });
                this._runChatLoop();
            },
            runWelcomePrompt: function (text) {
                if (!text || this.aiBusy) return;
                // Strip any leading emoji + space the chip carries.
                var cleaned = String(text).replace(/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F]+\s*/u, '').trim();
                this.aiInput = cleaned || text;
                this.sendChat();
            },

            _systemPrompt: function () {
                var locale = this.locale;
                var locName = (this.locales.find(function (l) { return l.code === locale; }) || {}).label || 'English';
                // Date only (no time-of-day) so the prompt prefix stays stable
                // for the whole day and remains KV-cache friendly on the LLM side.
                var today = new Date().toISOString().slice(0, 10);
                return [
                    'You are an astronomy assistant embedded in a planetarium web app (Stellarium Web).',
                    'Today\'s date is ' + today + '.',
                    'You can call tools to control the sky view and read its state. Use them whenever the user wants to "find / show / go to / look at / locate" objects, change time, change location, toggle layers, or zoom.',
                    'Tools available: select_object, get_selection, unselect, set_time, advance_time, reset_time, get_observer, set_observer_location, set_layer, set_fov, point_at.',
                    'After tool calls, briefly confirm what was done (1-2 sentences) and then answer.',
                    'For factual astronomy questions, answer concisely (3-6 sentences). You may use Markdown (lists, **bold**, headings, links) — it will render.',
                    'Reply in the user\'s language: ' + locName + '.'
                ].join(' ');
            },

            _runChatLoop: async function () {
                this.aiBusy = true;
                try {
                    var maxSteps = 4;
                    for (var step = 0; step < maxSteps; step++) {
                        var apiMessages = [{ role: 'system', content: this._systemPrompt() }]
                            .concat(this.aiMessages.map(function (m) {
                                var msg = { role: m.role, content: m.content || '' };
                                if (m.tool_calls) msg.tool_calls = m.tool_calls;
                                if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
                                if (m.name) msg.name = m.name;
                                // Some providers (Qwen/DeepSeek thinking mode) require
                                // the assistant's reasoning_content to be passed back.
                                if (m.reasoning_content) msg.reasoning_content = m.reasoning_content;
                                return msg;
                            }));

                        var result = await this._streamChat(apiMessages);
                        if (!result) return; // aborted or failed

                        if (!result.tool_calls || !result.tool_calls.length) return; // done

                        // Execute each tool call sequentially.
                        for (var i = 0; i < result.tool_calls.length; i++) {
                            var tc = result.tool_calls[i];
                            var fn = tc.function || {};
                            var toolResult;
                            try { toolResult = this._aiRunTool(fn.name, fn.arguments); }
                            catch (e) { toolResult = { ok: false, error: String(e) }; }
                            this.aiMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                name: fn.name,
                                content: JSON.stringify(toolResult)
                            });
                        }
                        // Loop: send tool results back, get a follow-up reply.
                    }
                } catch (e) {
                    if (e && e.name === 'AbortError') return;
                    this.aiMessages.push({ role: 'assistant', content: this.t('ai.error') + ' ' + String(e) });
                } finally {
                    this.aiBusy = false;
                    this.aiAbort = null;
                    this._scrollChatBottom();
                }
            },

            // Streams /chat/completions, appending content deltas live to a new
            // assistant message. Returns { content, tool_calls } so the caller
            // can decide whether to continue with tool execution.
            _streamChat: async function (messages) {
                var base = (this.llmBaseUrl || '').replace(/\/+$/, '');
                var url = base + '/chat/completions';
                this.aiAbort = new AbortController();

                var resp;
                try {
                    resp = await fetch(url, {
                        method: 'POST',
                        signal: this.aiAbort.signal,
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + this.llmApiKey,
                            'Accept': 'text/event-stream'
                        },
                        body: JSON.stringify({
                            model: this.llmModel,
                            messages: messages,
                            tools: TOOL_DEFS,
                            stream: true,
                            temperature: 0.4
                        })
                    });
                } catch (e) {
                    if (e && e.name === 'AbortError') return null;
                    throw e;
                }

                if (!resp.ok) {
                    var errText = await resp.text().catch(function () { return ''; });
                    this.aiMessages.push({
                        role: 'assistant',
                        content: this.t('ai.httpError', { status: resp.status }) +
                            (errText ? '\n\n```\n' + errText.slice(0, 400) + '\n```' : '')
                    });
                    return null;
                }

                // Append a placeholder assistant message that we'll mutate.
                var assistantIdx = this.aiMessages.length;
                this.aiMessages.push({ role: 'assistant', content: '', streaming: true });
                var assistant = this.aiMessages[assistantIdx];

                // tool_calls accumulator: keyed by index.
                var toolCallsByIdx = {};

                var reader = resp.body.getReader();
                var decoder = new TextDecoder('utf-8');
                var buffer = '';

                try {
                    while (true) {
                        var chunk = await reader.read();
                        if (chunk.done) break;
                        buffer += decoder.decode(chunk.value, { stream: true });

                        // Split on SSE event boundaries.
                        var events = buffer.split(/\r?\n\r?\n/);
                        buffer = events.pop();
                        for (var ei = 0; ei < events.length; ei++) {
                            var lines = events[ei].split(/\r?\n/);
                            for (var li = 0; li < lines.length; li++) {
                                var line = lines[li];
                                if (!line.startsWith('data:')) continue;
                                var payload = line.slice(5).trim();
                                if (!payload || payload === '[DONE]') continue;
                                var json;
                                try { json = JSON.parse(payload); } catch (e) { continue; }
                                var choice = json.choices && json.choices[0];
                                if (!choice) continue;
                                var delta = choice.delta || {};
                                if (delta.content) {
                                    // Reactively update the assistant message.
                                    this.$set(assistant, 'content', (assistant.content || '') + delta.content);
                                    this._scrollChatBottom();
                                }
                                // Capture reasoning_content (Qwen/DeepSeek thinking models).
                                if (delta.reasoning_content) {
                                    this.$set(assistant, 'reasoning_content',
                                        (assistant.reasoning_content || '') + delta.reasoning_content);
                                }
                                if (delta.tool_calls) {
                                    for (var ti = 0; ti < delta.tool_calls.length; ti++) {
                                        var d = delta.tool_calls[ti];
                                        var idx = d.index !== undefined ? d.index : ti;
                                        var tc = toolCallsByIdx[idx];
                                        if (!tc) {
                                            tc = { id: d.id || '', type: 'function', function: { name: '', arguments: '' } };
                                            toolCallsByIdx[idx] = tc;
                                        }
                                        if (d.id) tc.id = d.id;
                                        if (d.function) {
                                            if (d.function.name) tc.function.name += d.function.name;
                                            if (d.function.arguments) tc.function.arguments += d.function.arguments;
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    if (e && e.name === 'AbortError') {
                        this.$set(assistant, 'streaming', false);
                        return null;
                    }
                    throw e;
                }

                this.$set(assistant, 'streaming', false);

                var toolCalls = Object.keys(toolCallsByIdx)
                    .sort(function (a, b) { return Number(a) - Number(b); })
                    .map(function (k) { return toolCallsByIdx[k]; });

                if (toolCalls.length) {
                    // Persist tool_calls on the assistant message so they get
                    // included in the next API request.
                    this.$set(assistant, 'tool_calls', toolCalls);
                }

                return { content: assistant.content, tool_calls: toolCalls };
            },

            _scrollChatBottom: function () {
                this.$nextTick(function () {
                    var el = this.$refs.aiMessages;
                    if (el) el.scrollTop = el.scrollHeight;
                }.bind(this));
            }
        }
    };
})();
