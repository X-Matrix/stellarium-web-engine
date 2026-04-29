/* Stellarium Web — main Vue application. */
(function () {
    'use strict';

    Vue.component('stel-button', {
        template: '#stel-button-template',
        props: ['label', 'img', 'obj', 'attr'],
        computed: {
            value: function () { return this.obj && this.obj[this.attr]; }
        },
        methods: {
            clicked: function () {
                if (this.obj) this.obj[this.attr] = !this.obj[this.attr];
            }
        }
    });

    function getBaseUrl() {
        var url = document.location.href.split('/');
        url.pop();
        return url.join('/') + '/';
    }

    // ---- RA/Dec/Az formatting helpers (hoisted; pure functions) ----
    function padInt(num, padLen) {
        var s = String(num);
        while (s.length < padLen) s = '0' + s;
        return s;
    }
    function formatRA(stel, a) {
        var raf = stel.a2tf(a, 1);
        return '<div class="radecVal">' + padInt(raf.hours, 2) +
            '<span class="radecUnit">h</span>&nbsp;</div>' +
            '<div class="radecVal">' + padInt(raf.minutes, 2) +
            '<span class="radecUnit">m</span></div>' +
            '<div class="radecVal">' + padInt(raf.seconds, 2) +
            '.' + raf.fraction + '<span class="radecUnit">s</span></div>';
    }
    function formatDec(stel, a) {
        var raf = stel.a2af(a, 1);
        return '<div class="radecVal">' + raf.sign + padInt(raf.degrees, 2) +
            '<span class="radecUnit">°</span></div><div class="radecVal">' +
            padInt(raf.arcminutes, 2) +
            '<span class="radecUnit">\'</span></div><div class="radecVal">' +
            padInt(raf.arcseconds, 2) + '.' + raf.fraction +
            '<span class="radecUnit">"</span></div>';
    }
    function formatAz(stel, a) {
        var raf = stel.a2af(a, 1);
        var deg = raf.degrees < 0 ? raf.degrees + 180 : raf.degrees;
        return '<div class="radecVal">' + padInt(deg, 3) +
            '<span class="radecUnit">°</span></div><div class="radecVal">' +
            padInt(raf.arcminutes, 2) +
            '<span class="radecUnit">\'</span></div><div class="radecVal">' +
            padInt(raf.arcseconds, 2) + '.' + raf.fraction +
            '<span class="radecUnit">"</span></div>';
    }

    new Vue({
        vuetify: new Vuetify({ theme: { dark: true } }),
        el: '#app',
        mixins: [window.AiChatMixin],
        data: {
            drawer: false,
            stel: null,
            geoSnack: '',
            geoSnackVisible: false,
            culturalNames: [],
            selectionDescription: '',
            selectionDescLoading: false,
            selectionImage: '',
            selectionLink: '',
            descCache: Object.create(null),
            lastSelectionKey: null,
            searchQuery: '',
            searchLoading: false,
            searchError: '',
            searchErrorVisible: false,
            locale: 'en',
            locales: window.STEL_LOCALES,
            messages: window.STEL_MESSAGES
        },
        computed: {
            currentLocale: function () {
                var that = this;
                return this.locales.find(function (l) { return l.code === that.locale; }) || this.locales[0];
            }
        },
        mounted: function () {
            // Restore previously chosen locale; otherwise auto-detect from browser.
            var saved = null;
            try { saved = localStorage.getItem('stelweb.locale'); } catch (e) { /* ignore */ }
            if (saved && this.messages[saved]) {
                this.locale = saved;
            } else {
                var nav = (navigator.language || 'en').toLowerCase();
                if (nav.startsWith('zh')) this.locale = nav.indexOf('tw') >= 0 || nav.indexOf('hk') >= 0 ? 'zh-TW' : 'zh-CN';
                else if (nav.startsWith('ja')) this.locale = 'ja';
                else if (nav.startsWith('es')) this.locale = 'es';
            }
            this.restoreLlmSettings();

            var that = this;
            StelWebEngine({
                wasmFile: 'js/stellarium-web-engine.wasm',
                canvas: document.getElementById('stel-canvas'),
                translateFn: function (domain, str) { return str; },
                onReady: function (stel) {
                    that.stel = stel;
                    var baseUrl = getBaseUrl() + 'skydata/';
                    var core = stel.core;

                    core.stars.addDataSource({ url: baseUrl + 'stars' });
                    core.skycultures.addDataSource({ url: baseUrl + 'skycultures/western', key: 'western' });
                    core.dsos.addDataSource({ url: baseUrl + 'dso' });
                    core.landscapes.addDataSource({ url: baseUrl + 'landscapes/guereins', key: 'guereins' });
                    core.milkyway.addDataSource({ url: baseUrl + 'surveys/milkyway' });
                    core.minor_planets.addDataSource({ url: baseUrl + 'mpcorb.dat', key: 'mpc_asteroids' });
                    // Per-body HiPS textures hosted on Stellarium-Web's
                    // official CDN (DigitalOcean Spaces). The upstream
                    // bucket only allows CORS for stellarium-web.org, so we
                    // proxy through our /sso/* worker route — the browser
                    // sees a same-origin URL and the worker handles the
                    // upstream fetch + edge caching.
                    var ssoCdn = getBaseUrl() + 'sso/';
                    core.planets.addDataSource({ url: ssoCdn + 'moon/v1',     key: 'moon' });
                    core.planets.addDataSource({ url: ssoCdn + 'sun/v1',      key: 'sun' });
                    core.planets.addDataSource({ url: ssoCdn + 'mercury/v1',  key: 'mercury' });
                    core.planets.addDataSource({ url: ssoCdn + 'venus/v1',    key: 'venus' });
                    core.planets.addDataSource({ url: ssoCdn + 'mars/v1',     key: 'mars' });
                    core.planets.addDataSource({ url: ssoCdn + 'jupiter/v1',  key: 'jupiter' });
                    core.planets.addDataSource({ url: ssoCdn + 'saturn/v1',   key: 'saturn' });
                    core.planets.addDataSource({ url: ssoCdn + 'uranus/v1',   key: 'uranus' });
                    core.planets.addDataSource({ url: ssoCdn + 'neptune/v1',  key: 'neptune' });
                    core.planets.addDataSource({ url: ssoCdn + 'io/v1',       key: 'io' });
                    core.planets.addDataSource({ url: ssoCdn + 'europa/v1',   key: 'europa' });
                    core.planets.addDataSource({ url: ssoCdn + 'ganymede/v1', key: 'ganymede' });
                    core.planets.addDataSource({ url: ssoCdn + 'callisto/v1', key: 'callisto' });
                    // Generic fallback (Solar System Scope CC-BY texture).
                    core.planets.addDataSource({ url: ssoCdn + 'default/v1',  key: 'default' });
                    core.comets.addDataSource({ url: baseUrl + 'CometEls.txt', key: 'mpc_comets' });
                    core.satellites.addDataSource({ url: baseUrl + 'tle_satellite.jsonl.gz', key: 'jsonl/sat' });

                    stel.change(function (obj, attr) {
                        if (attr === 'hovered') return;
                        // Re-wrap to trigger Vue reactivity on nested mutations.
                        that.stel = Object.assign(Object.create(stel), stel);
                        if (attr === 'selection') that.onSelectionChanged();
                    });

                    stel.setFont('regular', 'static/fonts/Roboto-Regular.ttf', 1.38);
                    stel.setFont('bold', 'static/fonts/Roboto-Bold.ttf', 1.38);

                    that.setupGeolocation();
                }
            });
        },
        methods: {
            t: function (key, vars) {
                var dict = this.messages[this.locale] || this.messages.en;
                var s = dict[key];
                if (s === undefined) s = (this.messages.en && this.messages.en[key]) || key;
                if (vars) {
                    s = s.replace(/\{(\w+)\}/g, function (_, k) {
                        return vars[k] !== undefined ? vars[k] : '{' + k + '}';
                    });
                }
                return s;
            },
            setLocale: function (code) {
                if (!this.messages[code]) return;
                this.locale = code;
                try { localStorage.setItem('stelweb.locale', code); } catch (e) { /* ignore */ }
                this.lastSelectionKey = null;
                this.onSelectionChanged();
            },
            wikiLang: function () {
                var map = { 'en': 'en', 'zh-CN': 'zh', 'zh-TW': 'zh', 'ja': 'ja', 'es': 'es' };
                return map[this.locale] || 'en';
            },
            doSearch: function () {
                var q = (this.searchQuery || '').trim();
                if (!q || !this.stel) return;
                this.searchLoading = true;
                this.searchError = '';
                var that = this;
                setTimeout(function () {
                    try {
                        var stel = that.stel;
                        var candidates = [
                            q, 'NAME ' + q, q.toUpperCase(),
                            'NAME ' + q.replace(/\b\w/g, function (c) { return c.toUpperCase(); })
                        ];
                        var obj = null;
                        for (var i = 0; i < candidates.length; i++) {
                            obj = stel.getObj(candidates[i]);
                            if (obj) break;
                        }
                        if (!obj) {
                            that.searchError = that.t('search.notFound', { q: q });
                            that.searchErrorVisible = true;
                            return;
                        }
                        stel.core.selection = obj;
                        try { stel.pointAndLock(obj, 0.5); } catch (e) { /* ignore */ }
                    } catch (e) {
                        that.searchError = that.t('search.error');
                        that.searchErrorVisible = true;
                    } finally {
                        that.searchLoading = false;
                    }
                }, 0);
            },
            setupGeolocation: function () {
                var that = this;
                if (!navigator.geolocation) {
                    that.geoSnack = that.t('geo.unsupported');
                    that.geoSnackVisible = true;
                    return;
                }
                navigator.geolocation.getCurrentPosition(
                    function (pos) {
                        var lat = pos.coords.latitude;
                        var lng = pos.coords.longitude;
                        var alt = pos.coords.altitude || 0;
                        var obs = that.stel.core.observer;
                        obs.latitude = lat * Math.PI / 180;
                        obs.longitude = lng * Math.PI / 180;
                        if (alt) obs.elevation = alt;
                        that.geoSnack = that.t('geo.success', { lat: lat.toFixed(3), lng: lng.toFixed(3) });
                        that.geoSnackVisible = true;
                    },
                    function (err) {
                        var reason = (err && err.message) ? err.message : that.t('geo.denied');
                        that.geoSnack = that.t('geo.unavailable', { reason: reason });
                        that.geoSnackVisible = true;
                    },
                    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
                );
            },
            onSelectionChanged: function () {
                var sel = this.stel && this.stel.core.selection;
                if (!sel) {
                    this.culturalNames = [];
                    this.selectionDescription = '';
                    this.selectionDescLoading = false;
                    this.selectionImage = '';
                    this.selectionLink = '';
                    this.lastSelectionKey = null;
                    return;
                }
                // Make sure adaptive theme polling is running while the card
                // is visible.
                this._startCardThemePoll();
                try {
                    var cn = sel.culturalDesignations() || [];
                    this.culturalNames = cn.map(function (c) {
                        return {
                            native: c.name_native || '',
                            english: c.name_english || '',
                            pronounce: c.name_pronounce || '',
                            translated: c.name_translated || ''
                        };
                    }).filter(function (c) { return c.native || c.english || c.translated; });
                } catch (e) {
                    this.culturalNames = [];
                }
                var designations = sel.designations() || [];
                if (!designations.length) return;
                var key = designations[0];
                if (key === this.lastSelectionKey) return;
                this.lastSelectionKey = key;
                var query = this._wikiQueryFromDesignations(designations);
                this._loadDescription(query);
            },
            _wikiQueryFromDesignations: function (designations) {
                var named = designations.filter(function (d) { return /^NAME /.test(d); })
                    .map(function (d) { return d.replace(/^NAME /, ''); });
                if (named.length) return named[0].trim();
                var pri = designations[0];
                pri = pri.replace(/^(HD|HIP|SAO|HR|TYC|GAIA|GJ) /i, '');
                return pri.trim();
            },
            // ---- Adaptive info-card theming ----
            // Periodically sample the canvas pixels behind the info card,
            // measure mean luminance, and toggle a class so the card stays
            // readable on bright (daytime) and dark (night) skies alike.
            _startCardThemePoll: function () {
                if (this._cardThemeTimer) return;
                var that = this;
                var tick = function () {
                    that._updateCardTheme();
                };
                tick();
                this._cardThemeTimer = setInterval(tick, 600);
            },
            _stopCardThemePoll: function () {
                if (this._cardThemeTimer) {
                    clearInterval(this._cardThemeTimer);
                    this._cardThemeTimer = null;
                }
            },
            _updateCardTheme: function () {
                var card = document.querySelector('.info-card');
                var canvas = document.getElementById('stel-canvas');
                if (!card || !canvas) return;
                if (!card.offsetParent) {
                    // Card hidden — stop polling until next selection.
                    this._stopCardThemePoll();
                    return;
                }
                try {
                    var rect = card.getBoundingClientRect();
                    var cRect = canvas.getBoundingClientRect();
                    // Sample area = card bounds, clipped to canvas, scaled to
                    // canvas backing-store coords.
                    var sx = (rect.left - cRect.left) * (canvas.width / cRect.width);
                    var sy = (rect.top - cRect.top) * (canvas.height / cRect.height);
                    var sw = rect.width * (canvas.width / cRect.width);
                    var sh = rect.height * (canvas.height / cRect.height);
                    sx = Math.max(0, Math.min(canvas.width - 1, sx));
                    sy = Math.max(0, Math.min(canvas.height - 1, sy));
                    sw = Math.max(1, Math.min(canvas.width - sx, sw));
                    sh = Math.max(1, Math.min(canvas.height - sy, sh));

                    if (!this._sampleCanvas) {
                        this._sampleCanvas = document.createElement('canvas');
                        this._sampleCanvas.width = 16;
                        this._sampleCanvas.height = 16;
                    }
                    var sc = this._sampleCanvas;
                    var ctx = sc.getContext('2d');
                    // drawImage from the WebGL canvas — the browser composites
                    // the latest swap-chain frame into our 2D canvas.
                    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sc.width, sc.height);
                    var data = ctx.getImageData(0, 0, sc.width, sc.height).data;
                    var sum = 0, n = 0;
                    for (var i = 0; i < data.length; i += 4) {
                        // Rec. 601 luma
                        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                        n++;
                    }
                    var lum = n ? sum / n : 0; // 0..255
                    // Hysteresis to prevent flicker around the threshold.
                    var prev = card.classList.contains('info-card--bright');
                    var bright = prev ? lum > 110 : lum > 130;
                    card.classList.toggle('info-card--bright', bright);
                } catch (e) {
                    // Likely a cross-origin / readback issue — bail silently.
                }
            },
            _loadDescription: function (title) {
                var that = this;
                if (!title) {
                    this.selectionDescription = '';
                    this.selectionLink = '';
                    return;
                }
                var cacheKey = title + '|' + this.wikiLang();
                var cached = this.descCache[cacheKey];
                if (cached) {
                    this.selectionDescription = cached.extract;
                    this.selectionImage = cached.thumbnail;
                    this.selectionLink = cached.link;
                    this.selectionDescLoading = false;
                    return;
                }
                this.selectionDescription = '';
                this.selectionImage = '';
                this.selectionLink = '';
                this.selectionDescLoading = true;
                var url = '/api/wiki?title=' + encodeURIComponent(title) + '&lang=' + this.wikiLang();
                fetch(url)
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (j) {
                        if (that.lastSelectionKey === null) return;
                        var entry = {
                            extract: (j && j.extract) ? j.extract : '',
                            thumbnail: (j && j.thumbnail && j.thumbnail.source) ? j.thumbnail.source : '',
                            link: (j && j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) ? j.content_urls.desktop.page : ''
                        };
                        that.descCache[cacheKey] = entry;
                        that.selectionDescription = entry.extract;
                        that.selectionImage = entry.thumbnail;
                        that.selectionLink = entry.link;
                        that.selectionDescLoading = false;
                    })
                    .catch(function () {
                        that.selectionDescription = '';
                        that.selectionDescLoading = false;
                    });
            },
            getTitle: function (obj) {
                var name = obj.designations()[0];
                return name.replace(/^NAME /, '');
            },
            getProgress: function () {
                var bar = this.stel.core.progressbars[0];
                return { title: bar.label, value: bar.value / bar.total * 100 };
            },
            getInfos: function (obj) {
                var stel = this.stel;
                var obs = stel.core.observer;
                var cirs = stel.convertFrame(obs, 'ICRF', 'CIRS', obj.getInfo('radec'));
                var radec = stel.c2s(cirs);
                var observed = stel.convertFrame(obs, 'CIRS', 'OBSERVED', cirs);
                var azalt = stel.c2s(observed);
                var ra = stel.anp(radec[0]);
                var dec = stel.anpm(radec[1]);
                var az = stel.anp(azalt[0]);
                var alt = stel.anp(azalt[1]);
                var vmag = obj.getInfo('vmag');
                var distance = obj.getInfo('distance');
                var ret = [];
                ret.push({ key: this.t('magnitude'), value: vmag === undefined ? this.t('unknown') : vmag.toFixed(2) });
                if (distance !== undefined && distance > 0) {
                    var val;
                    if (distance > 1e5) {
                        var ly = distance / 63241.077;
                        val = ly >= 1000 ? (ly / 1000).toFixed(2) + ' kly' : ly.toFixed(2) + ' ly';
                    } else {
                        val = distance.toFixed(distance < 1 ? 4 : 3) + ' AU';
                    }
                    ret.push({ key: this.t('distance'), value: val });
                }
                ret.push({ key: this.t('radec'), value: formatRA(stel, ra) + '&nbsp;&nbsp;&nbsp;' + formatDec(stel, dec) });
                ret.push({ key: this.t('azalt'), value: formatAz(stel, az) + '&nbsp;&nbsp;&nbsp;' + formatDec(stel, alt) });
                return ret;
            }
        }
    });
})();
