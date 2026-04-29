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
                name: 'set_time',
                description: 'Set the planetarium clock to a given UTC ISO 8601 timestamp.',
                parameters: {
                    type: 'object',
                    properties: {
                        iso: { type: 'string', description: 'UTC ISO 8601 timestamp, e.g. "2025-08-12T22:00:00Z"' }
                    },
                    required: ['iso']
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
                            content: typeof m.content === 'string' && m.content.length > 240
                                ? m.content.slice(0, 240) + '…'
                                : (m.content || ''),
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
                var candidates = [
                    name, 'NAME ' + name, name.toUpperCase(),
                    'NAME ' + String(name).replace(/\b\w/g, function (c) { return c.toUpperCase(); })
                ];
                var obj = null;
                for (var i = 0; i < candidates.length; i++) {
                    obj = stel.getObj(candidates[i]);
                    if (obj) break;
                }
                if (!obj) return { ok: false, error: 'not found: ' + name };
                stel.core.selection = obj;
                try { stel.pointAndLock(obj, 0.8); } catch (e) { /* ignore */ }
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
            _aiRunTool: function (name, argsJson) {
                var args = {};
                try { args = JSON.parse(argsJson || '{}'); } catch (e) { /* ignore */ }
                if (name === 'select_object') return this._aiSelectObject(args.name);
                if (name === 'get_selection') return this._aiGetSelection();
                if (name === 'set_time') return this._aiSetTime(args.iso);
                return { ok: false, error: 'unknown tool: ' + name };
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

            _systemPrompt: function () {
                var sel = this._aiGetSelection();
                var locale = this.locale;
                var locName = (this.locales.find(function (l) { return l.code === locale; }) || {}).label || 'English';
                return [
                    'You are an astronomy assistant embedded in a planetarium web app (Stellarium Web).',
                    'You can call tools to control what the user sees: select_object centers the view on a celestial object;',
                    'get_selection returns what the user has currently selected; set_time changes the simulation clock.',
                    'When the user asks to "find", "show", "go to", "look at" or "locate" an object, call select_object.',
                    'After a successful tool call, briefly confirm what was done in 1-2 sentences, then answer their question.',
                    'For factual astronomy questions, answer concisely (3-6 sentences). You may use Markdown formatting (lists, **bold**, headings, links) — it will render.',
                    'Reply in the user\'s language: ' + locName + '.',
                    'Current selection: ' + JSON.stringify(sel) + '.'
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
