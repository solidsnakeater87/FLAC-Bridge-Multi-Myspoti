// FLAC Bridge Multi -- independent Myspoti adapter, GPL-3.0-only.
// Technical references: Mornye/SpotiFLAC provider sources, Copyright 2026 zarzet,
// LGPL-3.0-only. See README.md, LICENSE and LICENSE.txt. No passwords are collected.
(function () {
  'use strict';

  var GATE = 'https://api.zarz.moe/v2';
  var CALLBACK = 'spotiflac://session-grant';
  var INSTALL_KEY = 'installation_id';
  var PENDING_KEY = 'verification_pending';
  var AUTO_PAUSED_KEY = 'auto_verification_paused';
  var AUTO_RETRY_KEY = 'auto_verification_retry_after';
  var VERIFY_LIMIT_KEY = 'verification_rate_limit_until';
  var VERIFY_SERVER_LIMIT_KEY = 'verification_server_retry_after_until';
  var FORCE_GUARD_KEY = 'verification_manual_retry_after';
  var VERIFY_FORCE_KEY = 'verification_force_after_limit';
  var RENEW_CHECKED_PREFIX = 'verification_session_checked_';
  var RENEW_ATTEMPT_PREFIX = 'verification_refresh_retry_until_';
  var RENEW_INTERVAL_MS = 6 * 60 * 60 * 1000;
  var RENEW_SOON_MS = 60 * 60 * 1000;
  var RENEW_GUARD_MS = 15 * 60 * 1000;
  var providers = [
    { key: 'tidal', name: 'Tidal', app: 'tidal-web@1.2.5', storage: 'tidal_session' },
    { key: 'qobuz', name: 'Qobuz', app: 'qobuz-web@1.2.21', storage: 'qobuz_session' },
    { key: 'deezer', name: 'Deezer', app: 'deezer@1.3.5', storage: 'deezer_session' },
    { key: 'amazon', name: 'Amazon Music', app: 'amzn@2.3.12', storage: 'amazon_session' }
  ];
  var lastNotice = 0;
  var nonceCounter = 0;
  var autoQueue = [], autoRunning = false, autoHadFailure = false, autoAnnounced = false;
  // Qobuz 503 in the field: pause that provider briefly instead of blocking
  // Tidal on every song. This is memory-only; sessions are never removed.
  var qobuzUnavailableUntil = 0;
  var tidalStage = 'sessione';

  function text(v) { return v == null ? '' : String(v).trim(); }
  function log(message) { try { myspoti.log('[FLAC Bridge] ' + message); } catch (ignored) {} }
  function notify(message) { try { myspoti.notify(message); } catch (ignored) {} }
  function notice(message) {
    var n = Date.now();
    if (n - lastNotice >= 60000) { lastNotice = n; notify(message); }
  }
  function provider(key) {
    for (var i = 0; i < providers.length; i++) if (providers[i].key === key) return providers[i];
    return null;
  }
  // Classify exceptions into static messages. Never log exception text: it
  // can contain URLs, request headers or identifiers.
  function failureCategory(err) {
    var msg = text(err && err.message).toLowerCase();
    if (msg.indexOf('timeout') >= 0 || msg.indexOf('timed out') >= 0 || msg.indexOf('time out') >= 0) return 'timeout';
    if (msg.indexOf('data saver') >= 0) return 'risparmio dati attivo';
    if (msg.indexOf('unknownhost') >= 0 || msg.indexOf('unable to resolve host') >= 0 || msg.indexOf('dns') >= 0) return 'DNS non raggiungibile';
    if (msg.indexOf('more than') >= 0 && msg.indexOf('request') >= 0) return 'limite richieste di Myspoti';
    if (msg.indexOf('not in this extension') >= 0 || msg.indexOf('not granted') >= 0) return 'permesso o dominio non disponibile';
    if (msg.indexOf('connect') >= 0 || msg.indexOf('network') >= 0 || msg.indexOf('unreachable') >= 0) return 'connessione non disponibile';
    if (msg.indexOf('no_ticket') >= 0) return 'ticket non ricevuto';
    if (msg.indexOf('gateway_unavailable') >= 0) return 'risposta del server non disponibile';
    return 'errore non classificato';
  }
  function retryAfterMs(r, data) {
    var value = header(r && r.headers, 'retry-after'), seconds = 0, fromHeader = 0;
    if (/^\d+(?:\.\d+)?$/.test(value)) fromHeader = Number(value) * 1000;
    else { var date = Date.parse(value); if (isFinite(date)) fromHeader = Math.max(0, date - Date.now()); }
    if (data) seconds = Number(data.retry_after_seconds || data.retryAfterSeconds) || 0;
    return Math.max(isFinite(fromHeader) ? fromHeader : 0, isFinite(seconds) ? seconds * 1000 : 0);
  }
  // A 429 on bootstrap can apply to the common verification service. Keep
  // this separate from cancellation's cooldown. Normal automatic and source
  // buttons respect it. Only a user-requested, single forced attempt can try
  // earlier; the remote service can still refuse it. Sessions remain usable.
  function verificationWaitMs() {
    var until = Number(myspoti.storage.get(VERIFY_LIMIT_KEY)) || 0;
    return isFinite(until) ? Math.max(0, until - Date.now()) : 0;
  }
  function verificationWaitMessage() {
    return 'Verifiche automatiche in pausa dopo HTTP 429: ancora circa ' + humanWait(verificationWaitMs()) + '.';
  }
  function waitUntil(key) {
    var until = Number(myspoti.storage.get(key)) || 0;
    return isFinite(until) ? Math.max(0, until - Date.now()) : 0;
  }
  function humanWait(ms) {
    if (ms <= 60000) {
      var seconds = Math.max(1, Math.ceil(ms / 1000));
      return seconds + (seconds === 1 ? ' secondo' : ' secondi');
    }
    var minutes = Math.ceil(ms / 60000);
    if (minutes < 60) return minutes + (minutes === 1 ? ' minuto' : ' minuti');
    var hours = Math.floor(minutes / 60), rest = minutes % 60;
    return hours + (hours === 1 ? ' ora' : ' ore') +
      (rest ? ' e ' + rest + (rest === 1 ? ' minuto' : ' minuti') : '');
  }
  // Read only. This button must never trigger bootstrap, clear sessions, change
  // the stored wait, or claim a 429 has ended on the remote service.
  function showVerificationWaits() {
    var automatic429 = verificationWaitMs(), server = waitUntil(VERIFY_SERVER_LIMIT_KEY);
    var cancelled = waitUntil(AUTO_RETRY_KEY), guard = waitUntil(FORCE_GUARD_KEY);
    log(automatic429 > 0 ? 'Pausa automatica per HTTP 429: ancora circa ' + humanWait(automatic429) + '.' :
      'Pausa automatica per HTTP 429: nessuna attesa memorizzata.');
    log(server > 0 ? 'Attesa indicata da una risposta precedente del server e memorizzata: ancora circa ' + humanWait(server) + '.' :
      'Attesa del server: nessun tempo esplicito memorizzato. Il server può comunque rispondere HTTP 429.');
    if (server > 0) log('I pulsanti Attiva rispettano questa attesa; Forza verifica manuale può chiedere un solo tentativo anticipato.');
    if (cancelled > 0) log('Altra pausa automatica dopo verifica interrotta: ancora circa ' + humanWait(cancelled) + '.');
    if (guard > 0) log('Sicurezza tra tentativi manuali: attendi ancora circa ' + humanWait(guard) + '.');
    if (!automaticEnabled()) log('Verifica automatica: disattivata nelle impostazioni.');
    else if (!automaticAllowed()) log('Verifica automatica: sospesa dopo la cancellazione delle sessioni.');
    else log('Rinnovo delle sessioni: controllo previsto ogni 6 ore mentre Myspoti è attiva, salvo attese e disponibilità del servizio.');
    notify('Tempi di attesa riportati nel Registro; nessuna verifica è stata avviata.');
  }
  function verificationForceKeys() {
    var keys = myspoti.storage.get(VERIFY_FORCE_KEY);
    return Array.isArray(keys) ? keys.filter(function (key) { return !!provider(key); }).slice(0, providers.length) : [];
  }
  function markVerificationForce(p) {
    if (!p) return;
    var keys = verificationForceKeys();
    if (keys.indexOf(p.key) < 0) { keys.push(p.key); myspoti.storage.set(VERIFY_FORCE_KEY, keys); }
  }
  function clearVerificationForce(p) {
    if (!p) return;
    var keys = verificationForceKeys().filter(function (key) { return key !== p.key; });
    if (keys.length) myspoti.storage.set(VERIFY_FORCE_KEY, keys);
    else myspoti.storage.remove(VERIFY_FORCE_KEY);
  }
  function rememberVerificationLimit(r, p) {
    var data = {};
    try { if (r) data = r.json() || {}; } catch (ignored) {}
    var requested = retryAfterMs(r, data), now = Date.now();
    var wait = Math.max(15 * 60 * 1000, requested);
    var old = Number(myspoti.storage.get(VERIFY_LIMIT_KEY)) || 0;
    myspoti.storage.set(VERIFY_LIMIT_KEY, Math.max(old, now + wait));
    // Record the service's explicit wait separately from the conservative
    // automatic delay. The explicit force button can try early without erasing it.
    if (requested > 0) {
      var serverOld = Number(myspoti.storage.get(VERIFY_SERVER_LIMIT_KEY)) || 0;
      myspoti.storage.set(VERIFY_SERVER_LIMIT_KEY, Math.max(serverOld, now + requested));
    }
    // Preserve sources the gateway explicitly said to reverify, even when
    // their local session still looks valid and the queue must stop for 429.
    markVerificationForce(p);
    for (var i = 0; i < autoQueue.length; i++) if (autoQueue[i].force) markVerificationForce(provider(autoQueue[i].key));
    return requested;
  }
  // Last accepted verification or renewal is stored per source. This is not
  // proof that the remote source still works; it schedules the next attempt.
  function renewalNeeded(p, session) {
    if (!validSession(session)) return true;
    var now = Date.now(), checked = Number(myspoti.storage.get(RENEW_CHECKED_PREFIX + p.key)) || 0;
    var expires = session.expiresAt ? Date.parse(session.expiresAt) : NaN;
    return checked <= 0 || checked > now + 5 * 60 * 1000 || now - checked >= RENEW_INTERVAL_MS ||
      (isFinite(expires) && expires - now <= RENEW_SOON_MS);
  }
  function renewalRetryWait(p) { return waitUntil(RENEW_ATTEMPT_PREFIX + p.key); }
  // Myspoti has no timers. Its status probe runs approximately every five
  // minutes while the app is foregrounded or playing. It only requests an
  // online event; the signed renewals happen later within that event's budget.
  function scheduleRenewalIfDue() {
    if (!automaticAllowed() || retryDelayed() || verificationWaitMs() > 0 || autoRunning || myspoti.storage.get(PENDING_KEY)) return false;
    var forced = verificationForceKeys();
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i], session = myspoti.storage.get(p.storage);
      if (forced.indexOf(p.key) >= 0 || !validSession(session) || (renewalNeeded(p, session) && renewalRetryWait(p) <= 0)) {
        return startAutomatic(false, 'periodico');
      }
    }
    return false;
  }
  function remaining(deadline, requested) {
    var available = deadline - Date.now() - 350;
    if (available < 1000) throw new Error('TIME_BUDGET');
    return Math.max(1000, Math.min(requested, available));
  }
  function id() {
    var v = text(myspoti.storage.get(INSTALL_KEY));
    if (!/^[a-f0-9]{32}$/.test(v)) {
      // Anonymous installation identifier; not a credential.
      v = myspoti.util.sha256(String(Date.now()) + ':' + Math.random() + ':' + Math.random()).slice(0, 32);
      myspoti.storage.set(INSTALL_KEY, v);
    }
    return v;
  }
  function validSession(s) {
    return !!s && typeof s === 'object' && typeof s.id === 'string' && typeof s.secret === 'string' &&
      s.id.length > 0 && s.id.length <= 4096 && s.secret.length > 0 && s.secret.length <= 4096 &&
      s.id.indexOf('\u0000') < 0 && s.secret.indexOf('\u0000') < 0 && /^[a-f0-9]{32}$/.test(text(s.installId));
  }
  function saveSession(p, data, installId, old) {
    data = data && typeof data === 'object' ? data : {};
    var s = {
      id: text(data.session_id) || (old && old.id) || '',
      secret: text(data.session_secret) || (old && old.secret) || '',
      expiresAt: text(data.expires_at) || (old && old.expiresAt) || '',
      installId: installId
    };
    if (!validSession(s)) return false;
    myspoti.storage.set(p.storage, s);
    myspoti.storage.set(RENEW_CHECKED_PREFIX + p.key, Date.now());
    // A new completed verification replaces the old retry history. A refresh
    // itself retains its guard to avoid hammering if the service did not extend.
    if (!old) myspoti.storage.remove(RENEW_ATTEMPT_PREFIX + p.key);
    return true;
  }

  // Returns a small status so the automatic queue can stop or continue without
  // opening multiple sign-in pages. Manual pages are visible immediately.
  function beginVerification(p, automatic, deadline, forceManual, overrideStoredServerWait) {
    if (myspoti.storage.get(PENDING_KEY)) {
      if (!automatic) {
        log(p.name + ': una verifica è già aperta; completala o chiudila prima di riprovare.');
        notify('Una verifica è già aperta. Completa o chiudi quella pagina.');
      }
      return 'busy';
    }
    if (forceManual === true) {
      // The explicit Force button may request ONE early attempt despite an old
      // Retry-After. Ordinary source buttons still respect it. Preserve the
      // stored wait and automatic policy; the server can still refuse with 429.
      // All manual buttons share a short persistent debounce and a single page.
      var serverWait = waitUntil(VERIFY_SERVER_LIMIT_KEY), guardWait = waitUntil(FORCE_GUARD_KEY);
      if (serverWait > 0 && overrideStoredServerWait !== true) {
        log(p.name + ': verifica manuale in attesa del server; ancora circa ' + humanWait(serverWait) + '.');
        notify('Il server richiede ancora ' + humanWait(serverWait) + ' di attesa.');
        return 'rate-limited';
      }
      if (guardWait > 0) {
        log(p.name + ': attendi ancora circa ' + humanWait(guardWait) + ' prima di un altro tentativo manuale.');
        notify('Attendi ' + humanWait(guardWait) + ' prima di un altro tentativo manuale.');
        return 'rate-limited';
      }
      if (serverWait > 0 && overrideStoredServerWait === true) {
        log(p.name + ': tentativo anticipato richiesto nonostante l’attesa memorizzata dalla precedente risposta (' + humanWait(serverWait) + '); il server può rifiutarlo.');
      }
      myspoti.storage.set(FORCE_GUARD_KEY, Date.now() + 30000);
    } else if (verificationWaitMs() > 0) {
      if (!automatic) { log(p.name + ': ' + verificationWaitMessage()); notify(verificationWaitMessage()); }
      return 'rate-limited';
    }
    var result, install;
    try {
      install = id();
      if (overrideStoredServerWait === true) log(p.name + ': richiesta forzata al servizio di verifica in corso (un solo tentativo).');
      var r = myspoti.http.get(GATE + '/bootstrap?' + myspoti.query({ app_version: p.app, install_id: install }),
        { headers: { Accept: 'application/json' }, timeout: remaining(deadline, 6000) });
      if (!r || !r.ok) {
        log(p.name + ': avvio verifica non disponibile (HTTP ' + (r ? r.status : '0') + ').');
        if (r && Number(r.status) === 429) {
          var indicated = rememberVerificationLimit(r, p);
          if (overrideStoredServerWait === true) {
            log(p.name + ': il servizio ha risposto HTTP 429 al tentativo forzato; verifica non avviata.');
            log(indicated > 0 ? p.name + ': questa risposta indica circa ' + humanWait(indicated) + ' di attesa.' :
              p.name + ': questa risposta non indica un tempo di attesa esplicito leggibile.');
          }
          log(verificationWaitMessage());
          if (!automatic) notify(overrideStoredServerWait === true ? p.name + ': server HTTP 429. Dettagli nel Registro.' : verificationWaitMessage());
          return 'rate-limited';
        }
        if (!automatic) notify('Verifica ' + p.name + ' non disponibile. Riprova più tardi.');
        return 'failed';
      }
      result = r.json();
      if (saveSession(p, result, install, null)) {
        clearVerificationForce(p);
        log(p.name + ': sessione verificata.');
        if (!automatic) notify(p.name + ' attivato.');
        return 'complete';
      }
    } catch (err) {
      if (text(err && err.message) === 'TIME_BUDGET') return 'defer';
      log(p.name + ': impossibile raggiungere il server di verifica.');
      if (!automatic) notify('Verifica ' + p.name + ' non disponibile. Controlla la rete e riprova.');
      return 'failed';
    }
    var challenge = text(result && result.challenge_id);
    var serverNonce = text(result && result.server_nonce) || challenge;
    if (!challenge || !serverNonce) {
      log(p.name + ': risposta di verifica non riconosciuta.');
      if (!automatic) notify('Verifica ' + p.name + ' non riconosciuta.');
      return 'failed';
    }
    try {
      var state = myspoti.util.sha256(serverNonce + ':' + install + ':' + Math.random() + ':' + Date.now());
      var callback = CALLBACK + '?cb_version=v2grant&state=' + encodeURIComponent(state);
      var url = GATE + '/challenge?' + myspoti.query({ id: challenge, cb: callback });
      // Myspoti shows the SAME page after eight seconds if it needs the user;
      // this does not solve or circumvent a CAPTCHA.
      var authId = myspoti.auth.open({ url: url, callback: CALLBACK, hidden: automatic === true });
      var ttl = Number(result && result.expires_in);
      if (!isFinite(ttl) || ttl <= 0) ttl = 300;
      ttl = Math.min(300, Math.max(1, ttl));
      myspoti.storage.set(PENDING_KEY, { id: text(authId), provider: p.key, state: state,
        installId: install, until: Date.now() + ttl * 1000, automatic: automatic === true });
      log(p.name + ': pagina di verifica aperta' + (automatic ? ' automaticamente.' : '.'));
      return 'opened';
    } catch (ignored) {
      log(p.name + ': pagina di verifica non disponibile.');
      if (!automatic) notify('Impossibile aprire la verifica di ' + p.name + '. Chiudi altre pagine di accesso o aggiorna Android System WebView.');
      return 'auth-unavailable';
    }
  }
  function queryValues(url, depth) {
    if (depth > 2 || !url) return {};
    var raw = String(url), first = raw.indexOf('?');
    if (first < 0) first = raw.indexOf('#');
    if (first < 0) return {};
    var parts = raw.slice(first + 1).replace(/#/g, '&').split('&'), out = {};
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq < 0) continue;
      try {
        var k = decodeURIComponent(parts[i].slice(0, eq).replace(/\+/g, ' '));
        var v = decodeURIComponent(parts[i].slice(eq + 1).replace(/\+/g, ' '));
        if ((k === 'grant' || k === 'code' || k === 'state' || k === 'cb') && !out[k]) out[k] = v;
      } catch (ignored) {}
    }
    if (!out.grant && !out.code && out.cb) {
      var nested = queryValues(out.cb, depth + 1);
      if (nested.grant || nested.code) return nested;
    }
    return out;
  }
  function finishVerification(event) {
    var pending = myspoti.storage.get(PENDING_KEY);
    if (!pending || text(event && event.id) !== text(pending.id)) return;
    myspoti.storage.remove(PENDING_KEY);
    var p = provider(text(pending.provider));
    try {
      if (!p || event.error) throw new Error('CLOSED_OR_EXPIRED');
      var url = text(event.url);
      if (url.indexOf(CALLBACK + '?') !== 0 && url.indexOf(CALLBACK + '#') !== 0) throw new Error('INVALID_CALLBACK');
      if (Date.now() > Number(pending.until)) throw new Error('EXPIRED_CALLBACK');
      var vals = queryValues(url, 0), grant = text(vals.grant || vals.code);
      if (!grant || grant.length > 8192 || text(vals.state) !== text(pending.state)) throw new Error('INVALID_STATE');
      var body = JSON.stringify({ grant: grant, install_id: pending.installId, app_version: p.app, platform: 'extension' });
      var r = myspoti.http.post(GATE + '/session/exchange', body,
        { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 6500 });
      if (r && Number(r.status) === 429) {
        // The exchange can also be rate-limited. Keep any old session and
        // preserve the need to verify this provider for a later attempt.
        rememberVerificationLimit(r, p);
        log(p.name + ': creazione della sessione in pausa dopo HTTP 429.');
      }
      if (!r || !r.ok || !saveSession(p, r.json(), pending.installId, null)) {
        log(p.name + ': sessione non creata (HTTP ' + (r ? r.status : '0') + ').');
        throw new Error('EXCHANGE_FAILED');
      }
      clearVerificationForce(p);
      log(p.name + ': sessione verificata.');
      if (!pending.automatic) notify(p.name + ' attivato.');
      // The auth event has a 10 s budget. Ask for another online event instead
      // of doing the next bootstrap inside this callback.
      if (autoRunning && automaticAllowed()) wakeAutomatic();
    } catch (ignored) {
      log((p ? p.name + ': ' : '') + 'verifica non completata o ritorno non valido.');
      // Closing/cancelling one page must not immediately display the next one,
      // nor repeatedly reopen on every restart. A settings button can retry.
      if (automaticEnabled()) stopAutomatic(RENEW_INTERVAL_MS);
      else stopAutomatic(0);
      if (pending.automatic) notice('Verifica automatica interrotta. Puoi riprovare dalle impostazioni.');
      else notify('Verifica non completata. Riprova dalla pagina dell’estensione.');
    }
  }
  function hexToBase64Url(hex) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) throw new Error('BAD_MAC');
    var out = '';
    for (var i = 0; i < hex.length; i += 6) {
      var a = parseInt(hex.slice(i, i + 2), 16), hasB = i + 2 < hex.length, hasC = i + 4 < hex.length;
      var b = hasB ? parseInt(hex.slice(i + 2, i + 4), 16) : 0, c = hasC ? parseInt(hex.slice(i + 4, i + 6), 16) : 0;
      out += chars.charAt(a >> 2) + chars.charAt(((a & 3) << 4) | (b >> 4));
      if (hasB) out += chars.charAt(((b & 15) << 2) | (c >> 6));
      if (hasC) out += chars.charAt(c & 63);
    }
    return out;
  }
  function signedHeaders(p, session, method, path, body) {
    var now = Date.now(), timestamp = new Date(now).toISOString();
    var nonce = myspoti.util.sha256(session.secret + ':' + now + ':' + (++nonceCounter) + ':' + Math.random()).slice(0, 24);
    var digest = myspoti.util.sha256(body);
    var windowNumber = Math.floor(now / 300000);
    var rolling = hexToBase64Url(myspoti.util.hmacSha256(session.secret, String(windowNumber) + ':' + session.id));
    // The upstream protocol signs the escaped path and an empty query line, even for GETs.
    var canonical = ['ZARZ-HMAC-V1', method, '/v2' + path, '', digest, timestamp, nonce, session.id, p.app, 'extension'].join('\n');
    return {
      'Content-Type': 'application/json', Accept: 'application/json',
      'X-Zarz-Session': session.id, 'X-Zarz-Timestamp': timestamp, 'X-Zarz-Nonce': nonce,
      'X-Zarz-Body-SHA256': digest, 'X-Zarz-Signature': hexToBase64Url(myspoti.util.hmacSha256(rolling, canonical)),
      'X-Zarz-App-Version': p.app, 'X-Zarz-Platform': 'extension'
    };
  }
  function signedRequest(p, session, method, path, query, payload, extra, deadline) {
    if (!/^\/[a-z0-9/]+$/i.test(path) || (method !== 'GET' && method !== 'POST')) throw new Error('BAD_PATH');
    var body = method === 'POST' ? JSON.stringify(payload || {}) : '';
    var headers = signedHeaders(p, session, method, path, body);
    if (extra) Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
    var url = GATE + path + (query ? '?' + myspoti.query(query) : '');
    var timeout = remaining(deadline, p.key === 'tidal' ? 3800 : 3000);
    var r = method === 'POST' ? myspoti.http.post(url, body, { headers: headers, timeout: timeout }) :
      myspoti.http.get(url, { headers: headers, timeout: timeout });
    var data = {};
    try { if (r) data = r.json() || {}; } catch (ignored) {}
    if (!r || r.status !== 200) {
      var status = r ? Number(r.status) || 0 : 0, code = text(data.code).toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 50);
      log(p.name + ': server HTTP ' + status + (code ? ' (' + code + ')' : '') + '.');
      if (path === '/session/refresh' && status === 429) {
        // A refused renewal is not evidence that the stored session is bad.
        // Record the shared server wait, but do not force a new CAPTCHA solely
        // because refresh was rate-limited.
        rememberVerificationLimit(r, null);
        log(p.name + ': rinnovo in pausa dopo HTTP 429; sessione conservata.');
        log(verificationWaitMessage());
        throw new Error('RATE_LIMITED');
      }
      // A 503 from a Qobuz ticket/download is PROVIDER_UNAVAILABLE, not a
      // track 404: skip briefly. A refresh failure alone must not pause audio.
      if (p.key === 'qobuz' && path !== '/session/refresh' && status === 503 && code === 'PROVIDER_UNAVAILABLE') {
        var wait = Math.max(60000, retryAfterMs(r, data));
        qobuzUnavailableUntil = Math.max(qobuzUnavailableUntil, Date.now() + wait);
        log('Qobuz: sospesa temporaneamente dopo HTTP 503.');
      }
      if (status === 428 || code === 'VERIFY_REQUIRED' || (status === 401 && code === 'SESSION_INVALID') || (status === 403 && code === 'REQUEST_AUTH_INVALID')) {
        if (status === 401 && code === 'SESSION_INVALID' && path !== '/session/refresh') myspoti.storage.remove(p.storage);
        throw new Error('VERIFY_REQUIRED');
      }
      throw new Error('GATEWAY_UNAVAILABLE');
    }
    return data;
  }
  function activeSession(p, deadline, scheduledRenewal) {
    var s = myspoti.storage.get(p.storage);
    if (!validSession(s)) return null;
    var expires = s.expiresAt ? Date.parse(s.expiresAt) : NaN;
    var needsRefresh = scheduledRenewal === true || (isFinite(expires) && expires - Date.now() <= 300000);
    if (!needsRefresh) return s;
    // A recent failure or an explicit server 429 is never bypassed by an
    // automatic or audio-path refresh. An unexpired session can still play.
    if (verificationWaitMs() > 0 || renewalRetryWait(p) > 0) {
      if (scheduledRenewal === true) throw new Error(verificationWaitMs() > 0 ? 'RATE_LIMITED' : 'REFRESH_DELAYED');
      if (isFinite(expires) && expires <= Date.now()) throw new Error('GATEWAY_UNAVAILABLE');
      return s;
    }
    // Check the remaining hook budget before setting the guard; no request is
    // made if there is not enough time. The runtime serializes this extension.
    remaining(deadline, 3000);
    myspoti.storage.set(RENEW_ATTEMPT_PREFIX + p.key, Date.now() + RENEW_GUARD_MS);
    try {
      var fresh = signedRequest(p, s, 'POST', '/session/refresh', null, { install_id: s.installId }, null, deadline);
      if (!saveSession(p, fresh, s.installId, s)) throw new Error('REFRESH_FAILED');
      s = myspoti.storage.get(p.storage);
      log(p.name + ': richiesta di rinnovo della sessione accettata.');
    } catch (err) {
      var code = text(err && err.message);
      if (code === 'TIME_BUDGET') { myspoti.storage.remove(RENEW_ATTEMPT_PREFIX + p.key); throw err; }
      if (scheduledRenewal === true) throw err;
      if (code === 'VERIFY_REQUIRED') throw new Error('VERIFY_REQUIRED');
      if (isFinite(expires) && expires <= Date.now()) throw new Error('GATEWAY_UNAVAILABLE');
      // Any temporary failure leaves the still-valid session in place.
    }
    return s;
  }
  // Automatic work is event-driven: never open a second WebView until the first
  // one has returned, and never retry repeatedly after a user closes a page.
  function automaticEnabled() {
    try { return myspoti.settings.get('auto_verify') !== false; } catch (ignored) { return false; }
  }
  function automaticAllowed() {
    return automaticEnabled() && myspoti.storage.get(AUTO_PAUSED_KEY) !== true;
  }
  function retryDelayed() {
    var until = Number(myspoti.storage.get(AUTO_RETRY_KEY)) || 0;
    return until > Date.now();
  }
  function stopAutomatic(delayMs) {
    autoRunning = false;
    autoQueue = [];
    autoHadFailure = false;
    if (delayMs > 0) myspoti.storage.set(AUTO_RETRY_KEY, Date.now() + delayMs);
  }
  function wakeAutomatic() {
    if (!autoRunning || !automaticAllowed()) return false;
    try {
      myspoti.work.whenOnline();
      return true;
    } catch (ignored) {
      stopAutomatic(15 * 60 * 1000);
      log('Verifica automatica non avviabile.');
      notice('Verifica automatica non avviabile. Riprova dalle impostazioni.');
      return false;
    }
  }
  function startAutomatic(reset, reason) {
    if (!automaticEnabled()) {
      if (reset || reason === 'avvio') log('Verifica automatica disattivata: attiva l’interruttore nelle impostazioni.');
      if (reset) notify('Attiva prima la verifica automatica nelle impostazioni.');
      return false;
    }
    if (reset) {
      myspoti.storage.remove(AUTO_PAUSED_KEY);
      myspoti.storage.remove(AUTO_RETRY_KEY);
    }
    if (!automaticAllowed()) {
      if (reset || reason === 'avvio') log('Verifica automatica sospesa dopo la cancellazione delle sessioni: usa Riprova verifica automatica.');
      return false;
    }
    if (retryDelayed()) {
      if (reset || reason === 'avvio') {
        log('Verifica automatica in pausa: ancora circa ' + humanWait(waitUntil(AUTO_RETRY_KEY)) + '.');
        if (verificationWaitMs() > 0) log(verificationWaitMessage());
      }
      return false;
    }
    if (verificationWaitMs() > 0) {
      if (reset) notify(verificationWaitMessage());
      log(verificationWaitMessage());
      return false;
    }
    if (myspoti.storage.get(VERIFY_LIMIT_KEY)) myspoti.storage.remove(VERIFY_LIMIT_KEY);
    var forced = verificationForceKeys();
    autoQueue = providers.map(function (p) { return { key: p.key, force: forced.indexOf(p.key) >= 0 }; });
    autoRunning = true;
    autoHadFailure = false;
    autoAnnounced = false;
    if (reason === 'avvio') log('Avvio: controllo automatico delle sorgenti programmato; attendo la rete.');
    else if (reason === 'periodico') log('Controllo periodico programmato; attendo la rete.');
    else if (reset) log('Controllo automatico richiesto; attendo la rete.');
    return wakeAutomatic();
  }
  // A server can revoke a session before its locally recorded expiry. If a
  // normal request learns that, queue that provider without blocking the hook.
  function queueAutomatic(p) {
    if (!p || !automaticAllowed()) return false;
    // Preserve a newly rejected provider while any automatic pause is active;
    // otherwise a local expiry that still looks valid could be skipped later.
    if (retryDelayed() || verificationWaitMs() > 0) { markVerificationForce(p); return false; }
    if (!autoRunning) {
      autoQueue = [];
      autoRunning = true;
      autoHadFailure = false;
      autoAnnounced = false;
    }
    var pending = myspoti.storage.get(PENDING_KEY);
    if (pending && text(pending.provider) === p.key) return true;
    var found = false;
    for (var i = 0; i < autoQueue.length; i++) {
      if (autoQueue[i].key === p.key) { autoQueue[i].force = true; found = true; break; }
    }
    if (!found) autoQueue.push({ key: p.key, force: true });
    if (!pending) wakeAutomatic();
    return true;
  }
  function automaticStep() {
    if (!autoRunning) return;
    if (!automaticAllowed() || retryDelayed() || verificationWaitMs() > 0) { stopAutomatic(0); return; }
    log('Controllo automatico: rete disponibile, elaborazione delle sorgenti.');
    // The app's auth page sends an event when it ends. Never overwrite its
    // pending state, including while an explicitly requested page is open.
    if (myspoti.storage.get(PENDING_KEY)) return;
    var deadline = Date.now() + 22000;
    while (autoQueue.length) {
      if (deadline - Date.now() < 1400) { wakeAutomatic(); return; }
      var item = autoQueue.shift(), p = provider(item.key), force = item.force;
      if (!p) continue;
      if (!force) {
        var s = myspoti.storage.get(p.storage);
        if (validSession(s)) {
          var expires = s.expiresAt ? Date.parse(s.expiresAt) : NaN;
          if (renewalNeeded(p, s) && renewalRetryWait(p) <= 0) {
            try {
              log(p.name + ': rinnovo automatico della sessione richiesto.');
              s = activeSession(p, deadline, true);
              expires = s && s.expiresAt ? Date.parse(s.expiresAt) : NaN;
            } catch (err) {
              var reason = text(err && err.message);
              if (reason === 'TIME_BUDGET') { autoQueue.unshift(item); wakeAutomatic(); return; }
              if (reason === 'RATE_LIMITED') { stopAutomatic(0); return; }
              if (reason === 'VERIFY_REQUIRED') force = true;
              else {
                autoHadFailure = true;
                log(p.name + ': rinnovo non disponibile; sessione conservata e nuovo tentativo rinviato.');
                continue;
              }
            }
          }
          if (!force && validSession(s) && (!isFinite(expires) || expires > Date.now())) {
            log(p.name + ': sessione locale conservata.');
            continue;
          }
          if (!force && validSession(s) && renewalRetryWait(p) > 0) {
            autoHadFailure = true;
            log(p.name + ': sessione scaduta; rinnovo rinviato per evitare richieste ripetute.');
            continue;
          }
        }
      }
      var status = beginVerification(p, true, deadline);
      if (status === 'opened') {
        if (!autoAnnounced) {
          autoAnnounced = true;
          notify('Verifica automatica avviata. Completa eventuali richieste del server.');
        }
        return;
      }
      if (status === 'defer') { autoQueue.unshift(item); wakeAutomatic(); return; }
      if (status === 'busy') { autoQueue.unshift(item); return; }
      if (status === 'rate-limited') { stopAutomatic(0); return; }
      if (status === 'auth-unavailable') {
        stopAutomatic(15 * 60 * 1000);
        notice('Verifica sospesa. Chiudi altre pagine di accesso o aggiorna Android System WebView.');
        return;
      }
      if (status !== 'complete') autoHadFailure = true;
    }
    autoRunning = false;
    if (autoHadFailure) {
      myspoti.storage.set(AUTO_RETRY_KEY, Date.now() + 15 * 60 * 1000);
      log('Alcune verifiche automatiche non sono disponibili.');
      notice('Alcune verifiche non sono disponibili. Riprova dalle impostazioni.');
    } else {
      myspoti.storage.remove(AUTO_RETRY_KEY);
      log('Controllo automatico delle sorgenti completato.');
    }
    autoHadFailure = false;
  }

  function ticket(p, session, alias, resource, deadline) {
    var hash = myspoti.util.sha256(alias + ':track:' + text(resource).toLowerCase());
    var t = signedRequest(p, session, 'POST', '/tickets', null,
      { capability: 'download_ticket', provider: alias, resource_hash: hash }, null, deadline);
    var value = text(t && (t.ticket_id || t.ticket));
    if (!value || value.length > 4096) throw new Error('NO_TICKET');
    return value;
  }

  function isrc(v) {
    var s = text(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s.length === 12 ? s : '';
  }
  function normalize(v) {
    var s = text(v).toLowerCase();
    if (typeof s.normalize === 'function') {
      try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (ignored) {}
    }
    return s.replace(/&/g, ' and ').replace(/[^a-z0-9\u00c0-\u024f\u0370-\u04ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function durationMs(t) {
    var n = Number(t && t.durationMs);
    return isFinite(n) && n > 0 && n < 86400000 ? n : 0;
  }
  function numericId(value) {
    var s = text(value);
    return /^[0-9]{1,16}$/.test(s) && !(typeof value === 'number' && value > 9007199254740991) ? s : '';
  }
  function matchTrack(track, item, kind) {
    if (!item || typeof item !== 'object' || item.streamReady === false || item.allowStreaming === false || item.streamable === false) return null;
    var number = numericId(item.id); if (!number) return null;
    var expected = durationMs(track), actual = Number(item.duration) * 1000;
    if (!isFinite(actual) || actual <= 0 || actual > 86400000) actual = 0;
    var wanted = isrc(track.isrc), found = isrc(item.isrc), matched = !!wanted && wanted === found;
    if (wanted) {
      if (!matched || (expected && actual && Math.abs(expected - actual) > 10000)) return null;
    } else {
      var title = text(item.title);
      var version = text(item.version || item.title_version);
      if (version) title += ' ' + version;
      if (!normalize(track.title) || normalize(track.title) !== normalize(title)) return null;
      var artist = normalize(track.artist || (Array.isArray(track.artists) ? track.artists[0] : ''));
      var names = Array.isArray(item.artists) ? item.artists.slice() : [];
      if (item.artist) names.push(item.artist);
      if (item.performer) names.push(item.performer);
      var same = names.some(function (a) { return normalize(a && typeof a === 'object' ? a.name : a) === artist; });
      if (!artist || !same || !expected || !actual || Math.abs(expected - actual) > 3000) return null;
    }
    return { id: number, duration: actual, matched: matched, difference: expected && actual ? Math.abs(expected - actual) : 0,
      lossless: kind === 'tidal' && /LOSSLESS/i.test(text(item.audioQuality)) };
  }
  function bestHit(track, items, kind) {
    var hits = [];
    (Array.isArray(items) ? items.slice(0, 25) : []).forEach(function (x) {
      var m = matchTrack(track, x, kind); if (m) hits.push(m);
    });
    hits.sort(function (a, b) { if (a.lossless !== b.lossless) return a.lossless ? -1 : 1; return a.difference - b.difference; });
    return hits.length ? hits[0] : null;
  }
  function requestJson(url, headers, deadline, timeout, diagnostic) {
    var r = myspoti.http.get(url, { headers: headers || { Accept: 'application/json' }, timeout: remaining(deadline, timeout || 2600) });
    if (!r || !r.ok) {
      if (diagnostic === 'tidal') log('Tidal: catalogo HTTP ' + (r ? Number(r.status) || 0 : 0) + '.');
      return null;
    }
    try { return r.json(); } catch (ignored) {
      if (diagnostic === 'tidal') log('Tidal: risposta del catalogo non leggibile.');
      return null;
    }
  }
  function tidalHit(track, deadline) {
    var wanted = isrc(track.isrc), params, path;
    if (wanted) { path = '/tracks'; params = { isrc: wanted, countryCode: 'US', limit: 25 }; }
    else {
      if (!text(track.title) || !text(track.artist)) return null;
      path = '/search/tracks'; params = { query: (text(track.artist) + ' ' + text(track.title)).slice(0, 240), countryCode: 'US', limit: 25 };
    }
    var url = 'https://tidal.com/v1' + path + '?' + myspoti.query(params);
    var headers = { Accept: 'application/json', 'x-tidal-token': '49YxDN9a2aFV6RTG' }, j;
    try { j = requestJson(url, headers, deadline, 2600, 'tidal'); }
    catch (err) {
      // Only the idempotent catalogue GET is retried, and only a timeout with
      // enough time left. Never retry a signed POST, ticket or 429 here.
      if (failureCategory(err) !== 'timeout' || deadline - Date.now() < 7500) throw err;
      log('Tidal: timeout del catalogo; un nuovo tentativo.');
      j = requestJson(url, headers, deadline, 3200, 'tidal');
    }
    return bestHit(track, j && j.items, 'tidal');
  }
  function qobuzHit(track, p, session, deadline) {
    if (!text(track.title) || !text(track.artist)) return null;
    var params = { query: (text(track.artist) + ' ' + text(track.title)).slice(0, 240), limit: 25, offset: 0 };
    var j = null;
    try {
      j = requestJson('https://www.qobuz.com/api.json/0.2/track/search?' + myspoti.query(params),
        { Accept: 'application/json', 'X-App-Id': '735532640' }, deadline, 2400);
    } catch (ignored) {}
    var items = j && j.tracks && j.tracks.items;
    if (!Array.isArray(items)) {
      try {
        var query = { query: params.query, limit: params.limit, offset: 0, app_id: '798273057' };
        j = signedRequest(p, session, 'GET', '/qbz/track/search', query, null, null, deadline);
        items = j && j.tracks && j.tracks.items;
      } catch (ignored) { return null; }
    }
    return bestHit(track, items, 'qobuz');
  }
  function deezerHit(track, deadline) {
    var wanted = isrc(track.isrc), url;
    if (wanted) url = 'https://api.deezer.com/track/isrc:' + encodeURIComponent(wanted);
    else {
      if (!text(track.title) || !text(track.artist)) return null;
      url = 'https://api.deezer.com/search?' + myspoti.query({ q: (text(track.artist) + ' ' + text(track.title)).slice(0, 240), limit: 25 });
    }
    var j = requestJson(url, { Accept: 'application/json' }, deadline, 2400);
    return wanted ? matchTrack(track, j, 'deezer') : bestHit(track, j && j.data, 'deezer');
  }

  function trustedUrl(kind, url) {
    var match = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::443)?(?:\/|$)/i.exec(text(url));
    if (!match) return false;
    var host = match[1].toLowerCase();
    if (kind === 'tidal') return /^(?:[a-z0-9-]+\.)*audio\.tidal\.com$/.test(host);
    if (kind === 'qobuz') return host === 'streaming-qobuz-std.akamaized.net';
    if (kind === 'deezer') return host === 'dl.musicdl.me' || /^(?:[a-z0-9-]+\.)+dzcdn\.net$/.test(host);
    if (kind === 'amazon') return /^(?:[a-z0-9-]+\.)+cloudfront\.net$/.test(host);
    return false;
  }
  function decodedTidal(data) {
    if (!data || typeof data !== 'object' || text(data.assetPresentation).toUpperCase() === 'PREVIEW') return null;
    var quality = text(data.audioQuality).toUpperCase();
    if (quality && quality !== 'LOSSLESS' && quality !== 'HI_RES_LOSSLESS') return null;
    var encoded = text(data.manifest).replace(/\s+/g, '');
    if (!encoded || encoded.length > 1000000) return null;
    var decoded; try { decoded = myspoti.util.base64Decode(encoded); } catch (ignored) { return null; }
    if (/^\s*\{/.test(decoded)) {
      var b; try { b = JSON.parse(decoded); } catch (ignored) { return null; }
      var mime = text(b.mimeType).toLowerCase(), codec = text(b.codecs).toLowerCase(), enc = text(b.encryptionType).toUpperCase();
      if (mime !== 'audio/flac' || (codec && codec !== 'flac') || (enc && enc !== 'NONE')) return null;
      if (!Array.isArray(b.urls) || b.urls.length !== 1 || !trustedUrl('tidal', b.urls[0])) return null;
      return { url: text(b.urls[0]) };
    }
    if (!myspoti.features || myspoti.features.indexOf('audio.manifest') < 0 || decoded.indexOf('<MPD') < 0 ||
        !/codecs="flac"/i.test(decoded) || /<ContentProtection\b|<cenc:pssh\b|cenc:default_KID/i.test(decoded) ||
        !/<SegmentTimeline\b/i.test(decoded) || !/<S\b[^>]*\bd="\d+"/i.test(decoded)) return null;
    var reps = decoded.match(/<Representation\b/gi) || [], adaptations = decoded.match(/<AdaptationSet\b/gi) || [];
    if (reps.length !== 1 || adaptations.length !== 1) return null;
    var codecPattern = /\bcodecs\s*=\s*"([^"]+)"/gi, cm;
    while ((cm = codecPattern.exec(decoded))) if (text(cm[1]).toLowerCase() !== 'flac') return null;
    var init = /\binitialization="([^"]+)"/i.exec(decoded), media = /\bmedia="([^"]+)"/i.exec(decoded);
    if (!init || !media || !trustedUrl('tidal', init[1].replace(/&amp;/g, '&')) ||
        !trustedUrl('tidal', media[1].replace(/&amp;/g, '&')) || media[1].indexOf('$Number$') < 0) return null;
    return { manifest: encoded };
  }
  function header(headers, name) {
    var lower = name.toLowerCase(), keys = Object.keys(headers || {});
    for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === lower) return text(headers[keys[i]]);
    return '';
  }
  // Verify that a direct response is a real plain FLAC. Never download the full file
  // inside the script: Myspoti's network surface is limited to text and 5 MB.
  function plainFlacUrl(kind, url, deadline) {
    url = text(url);
    for (var n = 0; n < 3; n++) {
      if (!trustedUrl(kind, url)) return '';
      var r = myspoti.http.get(url, { headers: { Range: 'bytes=0-3', Accept: 'audio/flac,*/*' }, timeout: remaining(deadline, 2200) });
      if (!r) return '';
      if (r.status >= 300 && r.status < 400) {
        var location = header(r.headers, 'location');
        if (/^\//.test(location) && !/^\/\//.test(location)) {
          var base = /^(https:\/\/[^/]+)/i.exec(url);
          location = base ? base[1] + location : '';
        }
        url = location;
        continue;
      }
      if (r.status !== 206 || String(r.body || '').slice(0, 4) !== 'fLaC') return '';
      var contentRange = header(r.headers, 'content-range');
      if (contentRange && !/^bytes\s+0-\d+\/(?:\d+|\*)/i.test(contentRange)) return '';
      return url;
    }
    return '';
  }
  function positiveInt(value, min, max) {
    var n = Number(value); return isFinite(n) && Math.floor(n) === n && n >= min && n <= max ? n : 0;
  }
  function metadata(result, p, hit, bits, rate) {
    if (!result) return null;
    result.provider = p.name;
    result.duration = hit.duration;
    result.isrcMatched = hit.matched === true;
    var bd = positiveInt(bits, 8, 32), sr = Number(rate);
    if (isFinite(sr) && sr > 0 && sr < 1000) sr = Math.round(sr * 1000);
    sr = positiveInt(sr, 8000, 768000);
    if (bd) result.bitDepth = bd;
    if (sr) result.sampleRate = sr;
    return result;
  }
  function resolveTidal(track, p, session, deadline) {
    tidalStage = 'catalogo';
    var hit = tidalHit(track, deadline); if (!hit) return null;
    tidalStage = 'ticket';
    var t = ticket(p, session, 'tid', hit.id, deadline);
    tidalStage = 'stream';
    var response = signedRequest(p, session, 'POST', '/dl/tid', null,
      { id: hit.id, quality: 'LOSSLESS' }, { 'X-Zarz-Ticket': t }, deadline);
    var data = response && response.data, result = decodedTidal(data);
    return metadata(result, p, hit, data && data.bitDepth, data && data.sampleRate);
  }
  function looksPreview(data, hit) {
    if (!data || typeof data !== 'object') return false;
    if (booleanValue(data.sample) === true || booleanValue(data.preview) === true || booleanValue(data.is_preview) === true ||
        text(data.assetPresentation).toUpperCase() === 'PREVIEW') return true;
    var seconds = Number(data.duration), expected = Number(hit && hit.duration);
    return isFinite(seconds) && seconds > 0 && seconds < 86400 && expected > 0 && seconds * 1000 + 5000 < expected;
  }
  function resolveQobuz(track, p, session, deadline) {
    var hit = qobuzHit(track, p, session, deadline); if (!hit) return null;
    var trackUrl = 'https://open.qobuz.com/track/' + hit.id;
    var t = ticket(p, session, 'qbz', trackUrl, deadline);
    var response = signedRequest(p, session, 'POST', '/dl/qbz', null,
      { quality: 'cd', upload_to_r2: false, id: hit.id, type: 'track', url: trackUrl }, { 'X-Zarz-Ticket': t }, deadline);
    if (!response || response.success === false || response.error || response.detail) return null;
    var nested = response.data && typeof response.data === 'object' ? response.data : {};
    if (looksPreview(response, hit) || looksPreview(nested, hit)) return null;
    var url = text(response.download_url || response.url || response.link || nested.download_url || nested.url || nested.link);
    url = plainFlacUrl('qobuz', url, deadline);
    if (!url) { log('Qobuz: nessun FLAC diretto verificabile.'); return null; }
    return metadata({ url: url }, p, hit, response.bit_depth || nested.bit_depth, response.sampling_rate || nested.sampling_rate);
  }
  function booleanValue(v) {
    if (v === true || v === false) return v;
    if (text(v).toLowerCase() === 'true') return true;
    if (text(v).toLowerCase() === 'false') return false;
    return null;
  }
  function resolveDeezer(track, p, session, deadline) {
    var hit = deezerHit(track, deadline); if (!hit) return null;
    var trackUrl = 'https://www.deezer.com/track/' + hit.id;
    var t = ticket(p, session, 'dzr', trackUrl, deadline);
    var d = signedRequest(p, session, 'POST', '/dl/dzr', null,
      { id: hit.id, type: 'track', platform: 'deezer', url: trackUrl }, { 'X-Zarz-Ticket': t }, deadline);
    if (!d || d.success !== true || looksPreview(d, hit)) return null;
    var encrypted = booleanValue(d.deezer_encrypted), needs = booleanValue(d.requires_client_decryption), direct = booleanValue(d.direct_downloadable);
    if (encrypted === true || needs === true || direct === false || !(encrypted === false || needs === false || direct === true)) {
      log('Deezer: il file richiede decodifica non disponibile in Myspoti.'); return null;
    }
    var format = text(d.deezer_format || d.format).toLowerCase();
    if (format && format !== 'flac') return null;
    var url = text((direct === true && d.direct_download_url) || d.download_url || d.direct_download_url);
    url = plainFlacUrl('deezer', url, deadline);
    if (!url) { log('Deezer: nessun FLAC diretto verificabile.'); return null; }
    return metadata({ url: url }, p, hit, d.bit_depth, d.sample_rate);
  }
  function amazonAsin(url) {
    url = text(url).replace(/&amp;/g, '&');
    if (!/^https:\/\/music\.amazon\.(?:com|co\.uk|co\.jp|de|fr|it|es|in|com\.br|com\.mx|com\.au)(?:\/|$)/i.test(url)) return '';
    var q = /[?&]trackasin=([a-z0-9]{10})(?:[&#]|$)/i.exec(url);
    var path = /^https:\/\/[^/]+\/tracks?\/([a-z0-9]{10})(?:[/?#]|$)/i.exec(url);
    return text(q ? q[1] : path ? path[1] : '').toUpperCase();
  }
  function amazonHit(track, deadline) {
    var spotifyId = text(track && track.id);
    if (!/^[A-Za-z0-9]{22}$/.test(spotifyId)) return null;
    var r = myspoti.http.get('https://song.link/s/' + encodeURIComponent(spotifyId),
      { headers: { Accept: 'text/html' }, timeout: remaining(deadline, 2500) });
    if (!r || !r.ok || !r.body) return null;
    var scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, m, raw = '';
    while ((m = scripts.exec(String(r.body)))) {
      if (/(?:^|\s)id\s*=\s*["']__NEXT_DATA__["']/i.test(m[1])) { raw = m[2]; break; }
    }
    if (!raw) return null;
    var parsed; try { parsed = JSON.parse(raw); } catch (ignored) { return null; }
    var sections = parsed && parsed.props && parsed.props.pageProps && parsed.props.pageProps.pageData && parsed.props.pageProps.pageData.sections;
    if (!Array.isArray(sections)) return null;
    for (var i = 0; i < sections.length; i++) {
      var links = sections[i] && sections[i].links;
      if (!Array.isArray(links)) continue;
      for (var j = 0; j < links.length; j++) {
        var l = links[j];
        if (l && l.platform === 'amazonMusic' && l.show === true) {
          var asin = amazonAsin(l.url);
          if (asin) return { id: asin, duration: durationMs(track), matched: false };
        }
      }
    }
    return null;
  }
  function resolveAmazon(track, p, session, deadline) {
    var hit = amazonHit(track, deadline); if (!hit) return null;
    var t = ticket(p, session, 'amazeamazeamaze', hit.id, deadline);
    var d = signedRequest(p, session, 'POST', '/dl/amazeamazeamaze', null,
      { asin: hit.id, codec: 'flac' }, { 'X-Zarz-Ticket': t }, deadline);
    if (Array.isArray(d)) d = d.length ? d[0] : null;
    if (!d || !d.audio || text(d.audio.key) || booleanValue(d.audio.encrypted) === true || text(d.audio.codec).toLowerCase() !== 'flac') {
      log('Amazon Music: file cifrato o formato non compatibile.'); return null;
    }
    if (looksPreview(d, hit) || looksPreview(d.audio, hit)) return null;
    var want = isrc(track.isrc), got = isrc(d.meta && d.meta.isrc);
    if (want && got && want !== got) return null;
    var url = plainFlacUrl('amazon', d.audio.url, deadline);
    if (!url) { log('Amazon Music: nessun FLAC diretto verificabile.'); return null; }
    return metadata({ url: url }, p, hit, d.audio.bitDepth || d.audio.bitsPerSample, d.audio.sampleRate);
  }
  function preferenceOrder() {
    var preferred = '';
    try { preferred = text(myspoti.settings.get('preferred')); } catch (ignored) {}
    var result = [], first = null;
    for (var i = 0; i < providers.length; i++) if (providers[i].name === preferred) first = providers[i];
    if (first) result.push(first);
    for (var j = 0; j < providers.length; j++) if (!first || providers[j].key !== first.key) result.push(providers[j]);
    return result;
  }
  function resolve(track, budget, collectAll) {
    if (!track || typeof track !== 'object') return [];
    scheduleRenewalIfDue();
    var deadline = Date.now() + budget, order = preferenceOrder(), any = false, needsVerification = false, results = [];
    for (var i = 0; i < order.length; i++) {
      var p = order[i], stored = myspoti.storage.get(p.storage);
      if (!validSession(stored)) continue;
      any = true;
      if (p.key === 'qobuz' && Date.now() < qobuzUnavailableUntil) continue;
      if (deadline - Date.now() < 1400) break;
      if (p.key === 'tidal') tidalStage = 'sessione';
      try {
        var session = activeSession(p, deadline); if (!session) continue;
        var result = p.key === 'tidal' ? resolveTidal(track, p, session, deadline) :
          p.key === 'qobuz' ? resolveQobuz(track, p, session, deadline) :
          p.key === 'deezer' ? resolveDeezer(track, p, session, deadline) : resolveAmazon(track, p, session, deadline);
        if (result) {
          log('FLAC compatibile: ' + p.name + '.'); results.push(result);
          // Myspoti can try multiple download candidates after a transfer fails,
          // but its player accepts just one stream at a time.
          if (!collectAll) return results;
        } else log(p.name + ': nessun FLAC compatibile per questa ricerca.');
      } catch (err) {
        var code = text(err && err.message);
        if (code === 'VERIFY_REQUIRED') { needsVerification = true; queueAutomatic(p); log(p.name + ': serve una nuova verifica.'); }
        else if (code === 'TIME_BUDGET') {
          if (p.key === 'tidal') log('Tidal: tempo esaurito nella fase ' + tidalStage + '.');
          break;
        } else {
          if (p.key === 'tidal') log('Tidal: fase ' + tidalStage + ', ' + failureCategory(err) + '.');
          log(p.name + ': fonte non disponibile o risposta non utilizzabile.');
        }
      }
    }
    if (!any) {
      if (autoRunning && automaticAllowed()) notice('Attendi la verifica automatica delle sorgenti o completa la pagina aperta.');
      else notice('Apri FLAC Bridge Multi e attiva almeno una sorgente.');
    } else if (needsVerification && !results.length) {
      if (autoRunning && automaticAllowed()) notice('Una sorgente richiede una nuova verifica automatica.');
      else notice('Una sorgente richiede una nuova verifica nelle impostazioni di FLAC Bridge Multi.');
    }
    return results;
  }

  myspoti.on('setting', function (event) {
    if (!event) return;
    var key = text(event.key);
    if (key === 'auto_verify' && event.pressed !== true) {
      if (automaticEnabled()) startAutomatic(true);
      else { stopAutomatic(0); log('Verifica automatica disattivata.'); }
      return;
    }
    if (event.pressed !== true) return;
    if (key === 'verify') key = 'verify_tidal'; // Supports an event queued by version 1.
    if (key === 'show_waits') {
      showVerificationWaits();
    } else if (key === 'force_verify') {
      var chosen = preferenceOrder()[0];
      if (chosen) {
        log('Tentativo manuale richiesto per ' + chosen.name + '.');
        var manual = beginVerification(chosen, false, Date.now() + 20000, true, true);
        // An actual 429 must stop any background queue already in progress.
        if (manual === 'rate-limited' && verificationWaitMs() > 0 && autoRunning) stopAutomatic(0);
        else if (manual === 'complete' && autoRunning && automaticAllowed()) wakeAutomatic();
      }
    } else if (key === 'verify_all') {
      if (startAutomatic(true)) notify('Verifiche richieste: attendi la rete e completa le eventuali pagine.');
    } else if (key.indexOf('verify_') === 0) {
      var p = provider(key.slice(7));
      if (p) {
        // An explicit source button is a single manual request for that source,
        // just like Force, without changing the user's preferred audio source.
        // It may skip the local 15-minute delay but not a server Retry-After.
        log(p.name + ': avvio della verifica manuale richiesto.');
        var status = beginVerification(p, false, Date.now() + 20000, true);
        if (status === 'rate-limited' && verificationWaitMs() > 0 && autoRunning) stopAutomatic(0);
        else if (status === 'complete' && autoRunning && automaticAllowed()) wakeAutomatic();
        else if (status === 'auth-unavailable' && autoRunning) stopAutomatic(15 * 60 * 1000);
      }
    } else if (key === 'forget') {
      // Ignore the eventual callback of an already-open page and do not
      // recreate sessions until the user explicitly resumes automatic work.
      stopAutomatic(0);
      providers.forEach(function (p) {
        myspoti.storage.remove(p.storage);
        myspoti.storage.remove(RENEW_CHECKED_PREFIX + p.key);
        myspoti.storage.remove(RENEW_ATTEMPT_PREFIX + p.key);
      });
      myspoti.storage.remove(INSTALL_KEY); myspoti.storage.remove(PENDING_KEY);
      myspoti.storage.remove(AUTO_RETRY_KEY); myspoti.storage.remove(VERIFY_FORCE_KEY);
      // Keep a server 429 cooldown even when the user clears local sessions.
      myspoti.storage.set(AUTO_PAUSED_KEY, true);
      lastNotice = 0;
      log('Sessioni locali cancellate; verifica automatica sospesa.');
      notify('Sessioni cancellate. Verifica automatica sospesa: usa Riprova per riattivarla.');
    }
  });
  myspoti.on('auth', finishVerification);
  myspoti.on('online', automaticStep);
  // This hook is a cheap heartbeat, NOT a claim that the remote source is live.
  // Returning null preserves Myspoti's default 'not checked, still usable'
  // behavior. Do not perform network calls or open a page in this five-second hook.
  if (myspoti.features && myspoti.features.indexOf('status') >= 0) {
    myspoti.provide('status', function () { scheduleRenewalIfDue(); return null; });
  }
  myspoti.provide('audio-source', function (track) {
    var found = resolve(track, 13200, false)[0]; if (!found) return null;
    // Myspoti displays `source` only if structured quality is absent. Include the
    // provider and only real reported quality here, so users can see which one played.
    var label = found.provider + ' · FLAC';
    if (found.bitDepth) label += ' · ' + found.bitDepth + '-bit';
    if (found.sampleRate) label += ' · ' + (found.sampleRate / 1000) + ' kHz';
    var out = { source: label, expiresInMs: 300000 };
    if (found.url) { out.url = found.url; out.mimeType = 'audio/flac'; } else out.manifest = found.manifest;
    if (found.duration) out.durationMs = found.duration;
    return out;
  });
  myspoti.provide('download-source', function (track) {
    var all = resolve(track, 27000, true); if (!all.length) return null;
    return all.map(function (found) {
      var out = { format: found.url ? 'flac' : 'dash-flac', provider: found.provider, isrcMatched: found.isrcMatched };
      if (found.url) out.url = found.url; else out.manifest = found.manifest;
      if (found.bitDepth) out.bitDepth = found.bitDepth;
      if (found.sampleRate) out.sampleRate = found.sampleRate;
      return out;
    });
  });
  // Myspoti cancels an extension's auth page when its runtime stops. Any
  // persisted pending id is therefore stale after a restart/update.
  try {
    myspoti.storage.remove(PENDING_KEY);
    startAutomatic(false, 'avvio');
  } catch (ignored) {
    log('Impossibile inizializzare la verifica automatica.');
  }
})();
