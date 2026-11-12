// Career Fair 2026 — Adaptive Device & Network Speech-to-Text (STT) Router + Offline Whisper Engine
// Runs 100% in-browser offline speech-to-text via OpenAI Whisper (Transformers.js ONNX WASM/WebGPU)
// with dynamic failover across Cloud ElevenLabs Scribe, Cloudflare Edge Whisper, VoiceForge Local, and Web Speech API.
(function (global) {
  'use strict';

  const TRANSFORMERS_CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/transformers.min.js';
  const VOICEFORGE_LOCAL_URL = 'http://127.0.0.1:8765';
  const ALLOWED_STT_MODES = ['auto', 'whisper-offline', 'cloud-elevenlabs', 'browser-native'];
  const ALLOWED_WHISPER_MODELS = ['Xenova/whisper-tiny.en', 'Xenova/whisper-base.en'];

  let voiceForgeSttDownUntil = 0;
  let cachedModulePromise = null;
  const cachedPipelinePromises = new Map();
  let lastWhisperCacheStatus = { checkedAt: 0, modelId: '', cached: false };

  function normalizeSttMode(raw) {
    const val = String(raw || '').trim();
    return ALLOWED_STT_MODES.includes(val) ? val : 'auto';
  }

  function normalizeWhisperModel(raw) {
    const val = String(raw || '').trim();
    return ALLOWED_WHISPER_MODELS.includes(val) ? val : 'Xenova/whisper-tiny.en';
  }

  function stripWhisperNoiseTags(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    return rawText
      .replace(/<\|[^|>]+\|>/g, ' ')
      .replace(/\[(?:BLANK_AUDIO|NOISE|SILENCE|MUSIC|APPLAUSE|LAUGHTER|INAUDIBLE|UNKNOWN|CROSSTALK)\]/gi, ' ')
      .replace(/\([^)]{1,45}\)|\[[^\]]{1,45}\]|\*[^*]{1,45}\*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hasSpeechWords(text) {
    const cleaned = stripWhisperNoiseTags(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.length > 0;
  }

  function getConfiguredSttMode() {
    try {
      const domVal = document.getElementById('admin-stt-engine')?.value;
      if (domVal && ALLOWED_STT_MODES.includes(domVal)) return domVal;
    } catch {}
    try {
      const cfgVal = global.STATE?.config?.stt_mode;
      if (cfgVal && ALLOWED_STT_MODES.includes(cfgVal)) return cfgVal;
    } catch {}
    try {
      return normalizeSttMode(localStorage.getItem('cf_stt_mode') || 'auto');
    } catch {
      return 'auto';
    }
  }

  function getConfiguredWhisperModel() {
    try {
      const domVal = document.getElementById('admin-whisper-model')?.value;
      if (domVal && ALLOWED_WHISPER_MODELS.includes(domVal)) return domVal;
    } catch {}
    try {
      const cfgVal = global.STATE?.config?.whisper_model;
      if (cfgVal && ALLOWED_WHISPER_MODELS.includes(cfgVal)) return cfgVal;
    } catch {}
    try {
      return normalizeWhisperModel(localStorage.getItem('cf_whisper_model') || 'Xenova/whisper-tiny.en');
    } catch {
      return 'Xenova/whisper-tiny.en';
    }
  }

  function getDeviceAndNetworkSttProfile() {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const online = nav.onLine !== false;
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection || null;
    const effectiveType = String(conn?.effectiveType || (online ? '4g' : 'offline')).toLowerCase();
    const saveData = Boolean(conn?.saveData);
    const downlink = typeof conn?.downlink === 'number' ? conn.downlink : (online ? 10 : 0);

    let networkQuality = 'fast';
    if (!online) {
      networkQuality = 'offline';
    } else if (saveData || effectiveType === 'slow-2g' || effectiveType === '2g' || (effectiveType === '3g' && downlink < 1.2)) {
      networkQuality = 'constrained';
    } else if (effectiveType === '3g') {
      networkQuality = 'moderate';
    }

    const deviceMemoryGB = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
    const cpuCores = typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : 4;
    const hasWasm = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
    const hasWebGPU = Boolean(nav.gpu);
    const hasAudioDecode = Boolean(global.AudioContext || global.webkitAudioContext);
    const hasMediaRecorder = typeof global.MediaRecorder !== 'undefined';
    const hasSpeechRecognition = Boolean(global.SpeechRecognition || global.webkitSpeechRecognition);

    const whisperSupported = Boolean(
      hasWasm &&
      hasAudioDecode &&
      hasMediaRecorder &&
      (deviceMemoryGB === null || deviceMemoryGB >= 2) &&
      cpuCores >= 2
    );

    const whisperDevice = hasWebGPU && (deviceMemoryGB === null || deviceMemoryGB >= 4) ? 'webgpu' : 'wasm';
    const whisperTier = !whisperSupported
      ? 'unsupported'
      : ((deviceMemoryGB === null || deviceMemoryGB >= 4) && cpuCores >= 4 ? 'high' : 'compact');

    const cfg = global.STATE?.config || {};
    let lsEleven = '';
    try {
      lsEleven = localStorage.getItem('cf_eleven_keys') || localStorage.getItem('cf_eleven_key') || '';
    } catch {}
    const hasElevenKey = Boolean(cfg.eleven_key || cfg.eleven_keys || cfg.has_eleven_key || lsEleven);
    const hasWorkersAi = Boolean(cfg.has_workers_ai);
    const requestedMode = getConfiguredSttMode();
    const whisperModel = getConfiguredWhisperModel();
    const cachedModelReady = Boolean(
      lastWhisperCacheStatus.cached && lastWhisperCacheStatus.modelId === whisperModel
    );

    return {
      online,
      effectiveType,
      saveData,
      downlink,
      networkQuality,
      deviceMemoryGB,
      cpuCores,
      hasWasm,
      hasWebGPU,
      hasAudioDecode,
      hasMediaRecorder,
      hasSpeechRecognition,
      whisperSupported,
      whisperDevice,
      whisperTier,
      hasElevenKey,
      hasWorkersAi,
      hasCloudEndpoint: hasElevenKey || hasWorkersAi,
      requestedMode,
      whisperModel,
      cachedModelReady
    };
  }

  async function inspectWhisperCache(modelId) {
    const targetModel = normalizeWhisperModel(modelId || getConfiguredWhisperModel());
    const needle = targetModel.toLowerCase();
    let cached = false;
    try {
      if (typeof caches !== 'undefined' && typeof caches.open === 'function') {
        const cache = await caches.open('transformers-cache');
        const keys = await cache.keys();
        cached = keys.some((req) => String(req.url || '').toLowerCase().includes(needle) && String(req.url || '').toLowerCase().includes('.onnx'));
      }
    } catch {}
    lastWhisperCacheStatus = { checkedAt: Date.now(), modelId: targetModel, cached };
    return cached;
  }

  function resolveSttStrategy(opts = {}) {
    const profile = getDeviceAndNetworkSttProfile();
    const mode = normalizeSttMode(opts.mode || profile.requestedMode);

    if (mode === 'whisper-offline') {
      if (profile.whisperSupported) {
        return {
          requestedMode: mode,
          activeEngine: 'whisper-offline',
          useAudioRecorder: true,
          useAudioSegmentWhisper: true,
          useCloudStt: false,
          useRealtimeWebSpeech: false,
          badgeLabel: `🤖 Offline Whisper AI (${profile.whisperDevice.toUpperCase()})`,
          reason: `Admin selected Offline Whisper · ${profile.cpuCores} cores, ${profile.deviceMemoryGB ? profile.deviceMemoryGB + 'GB RAM' : 'Standard RAM'}, ${profile.whisperDevice.toUpperCase()} ready.`,
          profile
        };
      }
      if (profile.hasSpeechRecognition && profile.online) {
        return {
          requestedMode: mode,
          activeEngine: 'browser-native',
          useAudioRecorder: false,
          useAudioSegmentWhisper: false,
          useCloudStt: false,
          useRealtimeWebSpeech: true,
          badgeLabel: '🌐 Browser Web Speech (Device WASM Limited)',
          reason: 'Device lacks WASM/Audio/MediaRecorder capacity for Whisper; fell back to Browser Web Speech.',
          profile
        };
      }
      return {
        requestedMode: mode,
        activeEngine: 'manual',
        useAudioRecorder: false,
        useAudioSegmentWhisper: false,
        useCloudStt: false,
        useRealtimeWebSpeech: false,
        badgeLabel: '⌨️ Manual Transcript Fallback',
        reason: 'Neither Whisper WASM nor Web Speech is supported on this device.',
        profile
      };
    }

    if (mode === 'cloud-elevenlabs') {
      if (profile.online && (profile.hasCloudEndpoint || profile.hasMediaRecorder)) {
        return {
          requestedMode: mode,
          activeEngine: 'cloud-elevenlabs',
          useAudioRecorder: profile.hasMediaRecorder,
          useAudioSegmentWhisper: profile.whisperSupported,
          useCloudStt: true,
          useRealtimeWebSpeech: profile.hasSpeechRecognition,
          badgeLabel: '🎙️ Cloud ElevenLabs Scribe (+ Whisper Failover)',
          reason: 'Admin selected Cloud ElevenLabs Scribe with automatic Offline Whisper failover if cloud/quota fails.',
          profile
        };
      }
      if (profile.whisperSupported) {
        return {
          requestedMode: mode,
          activeEngine: 'whisper-offline',
          useAudioRecorder: true,
          useAudioSegmentWhisper: true,
          useCloudStt: false,
          useRealtimeWebSpeech: false,
          badgeLabel: '🤖 Offline Whisper AI (Auto-Switched: Offline)',
          reason: 'Browser is offline; automatically switched from Cloud STT to Offline Whisper.',
          profile
        };
      }
    }

    if (mode === 'browser-native') {
      if (profile.hasSpeechRecognition && profile.online) {
        return {
          requestedMode: mode,
          activeEngine: 'browser-native',
          useAudioRecorder: profile.whisperSupported && profile.hasMediaRecorder,
          useAudioSegmentWhisper: false,
          useCloudStt: false,
          useRealtimeWebSpeech: true,
          badgeLabel: '🌐 Browser Native Web Speech (en-IN)',
          reason: 'Admin selected Browser Native Web Speech API.',
          profile
        };
      }
      if (profile.whisperSupported) {
        return {
          requestedMode: mode,
          activeEngine: 'whisper-offline',
          useAudioRecorder: true,
          useAudioSegmentWhisper: true,
          useCloudStt: false,
          useRealtimeWebSpeech: false,
          badgeLabel: '🤖 Offline Whisper AI (Native Speech Unavailable)',
          reason: 'Browser Web Speech is unavailable or offline; switched to Offline Whisper.',
          profile
        };
      }
    }

    // 'auto' — Adaptive Device + Network Availability Routing
    if (!profile.online || profile.networkQuality === 'constrained') {
      if (profile.whisperSupported) {
        return {
          requestedMode: 'auto',
          activeEngine: 'whisper-offline',
          useAudioRecorder: true,
          useAudioSegmentWhisper: true,
          useCloudStt: false,
          useRealtimeWebSpeech: false,
          badgeLabel: !profile.online
            ? `🤖 Offline Whisper AI (${profile.whisperDevice.toUpperCase()} · Offline)`
            : `🤖 On-Device Whisper AI (Low Bandwidth: ${profile.effectiveType.toUpperCase()})`,
          reason: !profile.online
            ? 'Network offline detected -> running 100% on-device Whisper STT.'
            : `Constrained network (${profile.effectiveType}${profile.saveData ? '/Save-Data' : ''}) -> conserving data with on-device Whisper STT.`,
          profile
        };
      }
      if (profile.hasSpeechRecognition && profile.online) {
        return {
          requestedMode: 'auto',
          activeEngine: 'browser-native',
          useAudioRecorder: false,
          useAudioSegmentWhisper: false,
          useCloudStt: false,
          useRealtimeWebSpeech: true,
          badgeLabel: '🌐 Lightweight Web Speech (Low-Spec Device)',
          reason: 'Low-RAM/constrained device -> using lightweight native speech recognition.',
          profile
        };
      }
      return {
        requestedMode: 'auto',
        activeEngine: 'manual',
        useAudioRecorder: false,
        useAudioSegmentWhisper: false,
        useCloudStt: false,
        useRealtimeWebSpeech: false,
        badgeLabel: '⌨️ Offline Manual Input (Hardware Limited)',
        reason: 'Offline device without cached Whisper/Web Speech support.',
        profile
      };
    }

    // Online + healthy network ('moderate' or 'fast')
    if (profile.hasCloudEndpoint) {
      return {
        requestedMode: 'auto',
        activeEngine: 'cloud-elevenlabs',
        useAudioRecorder: profile.hasMediaRecorder,
        useAudioSegmentWhisper: profile.whisperSupported,
        useCloudStt: true,
        useRealtimeWebSpeech: profile.hasSpeechRecognition,
        badgeLabel: `🎙️ Adaptive Cloud Scribe + ${profile.whisperSupported ? 'Whisper Failover' : 'Live'}`,
        reason: `Online (${profile.effectiveType}) + Cloud STT active; ${profile.whisperSupported ? 'Offline Whisper armed as instant failover.' : 'Browser Speech active.'}`,
        profile
      };
    }

    if (profile.whisperSupported && (!profile.hasSpeechRecognition || profile.cachedModelReady || profile.whisperTier === 'high')) {
      return {
        requestedMode: 'auto',
        activeEngine: 'whisper-offline',
        useAudioRecorder: true,
        useAudioSegmentWhisper: true,
        useCloudStt: false,
        useRealtimeWebSpeech: profile.hasSpeechRecognition,
        badgeLabel: profile.hasSpeechRecognition
          ? `🤖 Offline Whisper + Live Preview (${profile.whisperDevice.toUpperCase()})`
          : `🤖 On-Device Whisper AI (${profile.whisperDevice.toUpperCase()})`,
        reason: `No cloud STT key needed; capable device (${profile.whisperDevice.toUpperCase()}) running Whisper${profile.hasSpeechRecognition ? ' with live WebSpeech preview' : ''}.`,
        profile
      };
    }

    if (profile.hasSpeechRecognition) {
      return {
        requestedMode: 'auto',
        activeEngine: 'browser-native',
        useAudioRecorder: profile.whisperSupported && profile.hasMediaRecorder,
        useAudioSegmentWhisper: profile.whisperSupported,
        useCloudStt: false,
        useRealtimeWebSpeech: true,
        badgeLabel: '🌐 Browser Live Speech (+ Whisper Fallback)',
        reason: 'Online compact/moderate device using zero-download WebSpeech with Whisper fallback on errors.',
        profile
      };
    }

    return {
      requestedMode: 'auto',
      activeEngine: profile.whisperSupported ? 'whisper-offline' : 'manual',
      useAudioRecorder: profile.whisperSupported,
      useAudioSegmentWhisper: profile.whisperSupported,
      useCloudStt: false,
      useRealtimeWebSpeech: false,
      badgeLabel: profile.whisperSupported ? '🤖 On-Device Whisper AI' : '⌨️ Manual Transcript Fallback',
      reason: profile.whisperSupported ? 'Browser lacks WebSpeech; using On-Device Whisper.' : 'No microphone STT API available.',
      profile
    };
  }

  async function decodeAudioBlobTo16kHzMono(audioBlob) {
    if (!audioBlob || typeof audioBlob.arrayBuffer !== 'function') {
      throw new Error('Invalid audio blob');
    }
    const arrayBuf = await audioBlob.arrayBuffer();
    if (!arrayBuf || arrayBuf.byteLength < 64) {
      return { pcm: new Float32Array(0), rms: 0, peak: 0, durationSec: 0 };
    }

    const AudioCtx = global.AudioContext || global.webkitAudioContext;
    if (!AudioCtx) throw new Error('AudioContext not supported');

    const decodeCtx = new AudioCtx({ sampleRate: 16000 });
    let decoded;
    try {
      decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
    } finally {
      try { await decodeCtx.close(); } catch {}
    }

    const targetRate = 16000;
    let pcm;
    const OfflineCtx = global.OfflineAudioContext || global.webkitOfflineAudioContext;

    if (OfflineCtx && (decoded.sampleRate !== targetRate || decoded.numberOfChannels > 1)) {
      const frameCount = Math.max(1, Math.ceil(decoded.duration * targetRate));
      const offlineCtx = new OfflineCtx(1, frameCount, targetRate);
      const src = offlineCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(offlineCtx.destination);
      src.start(0);
      const rendered = await offlineCtx.startRendering();
      pcm = rendered.getChannelData(0);
    } else if (decoded.numberOfChannels === 1) {
      pcm = decoded.getChannelData(0);
    } else {
      const len = decoded.length;
      pcm = new Float32Array(len);
      const chCount = decoded.numberOfChannels || 1;
      for (let c = 0; c < chCount; c++) {
        const ch = decoded.getChannelData(c);
        for (let i = 0; i < len; i++) pcm[i] += ch[i];
      }
      const inv = 1 / chCount;
      for (let i = 0; i < len; i++) pcm[i] *= inv;
    }

    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = Math.abs(pcm[i]);
      if (v > peak) peak = v;
      sumSq += pcm[i] * pcm[i];
    }
    const rms = pcm.length ? Math.sqrt(sumSq / pcm.length) : 0;
    const durationSec = pcm.length / targetRate;
    return { pcm, rms, peak, durationSec };
  }

  async function tryVoiceForgeLocalStt(audioBlob) {
    if (!audioBlob || Date.now() < voiceForgeSttDownUntil) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 450);
      let healthOk = false;
      try {
        const hRes = await fetch(`${VOICEFORGE_LOCAL_URL}/health`, { method: 'GET', signal: ctrl.signal });
        healthOk = Boolean(hRes && hRes.ok);
      } finally {
        clearTimeout(t);
      }
      if (!healthOk) {
        voiceForgeSttDownUntil = Date.now() + 20000;
        return null;
      }

      const fd = new FormData();
      fd.append('file', audioBlob, 'speech.webm');
      const res = await fetch(`${VOICEFORGE_LOCAL_URL}/stt`, { method: 'POST', body: fd });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      if (data && data.ok && typeof data.text === 'string') {
        voiceForgeSttDownUntil = 0;
        const clean = stripWhisperNoiseTags(data.text);
        return { ok: true, text: hasSpeechWords(clean) ? clean : '', provider: 'VoiceForge Local Whisper' };
      }
    } catch {
      voiceForgeSttDownUntil = Date.now() + 20000;
    }
    return null;
  }

  async function loadTransformersModule() {
    if (typeof global.__CF_LOAD_TRANSFORMERS_FN === 'function') {
      return await global.__CF_LOAD_TRANSFORMERS_FN();
    }
    if (!cachedModulePromise) {
      cachedModulePromise = import(TRANSFORMERS_CDN_URL).catch((err) => {
        cachedModulePromise = null;
        throw err;
      });
    }
    return cachedModulePromise;
  }

  async function getWhisperPipeline(modelId, opts = {}) {
    const profile = getDeviceAndNetworkSttProfile();
    const targetModel = normalizeWhisperModel(modelId || profile.whisperModel);
    const preferredDevice = opts.device || profile.whisperDevice || 'wasm';
    const cacheKey = `${targetModel}::${preferredDevice}`;

    if (typeof global.__CF_WHISPER_TRANSCRIBER === 'function') {
      return { transcriber: global.__CF_WHISPER_TRANSCRIBER, device: preferredDevice, modelId: targetModel };
    }

    if (cachedPipelinePromises.has(cacheKey)) {
      return cachedPipelinePromises.get(cacheKey);
    }

    const loaderPromise = (async () => {
      const mod = await loadTransformersModule();
      if (!mod || typeof mod.pipeline !== 'function') {
        throw new Error('Transformers.js pipeline loader unavailable');
      }
      if (mod.env) {
        mod.env.allowLocalModels = false;
        mod.env.useBrowserCache = true;
        if (mod.env.backends?.onnx?.wasm) {
          mod.env.backends.onnx.wasm.numThreads = Math.min(2, Math.max(1, profile.cpuCores || 2));
        }
      }

      const buildOpts = (deviceName) => ({
        device: deviceName,
        dtype: profile.whisperTier === 'high' ? 'q8' : 'q4',
        progress_callback: (prog) => {
          if (typeof opts.onProgress === 'function') {
            try { opts.onProgress(prog); } catch {}
          }
        }
      });

      let transcriber;
      let activeDevice = preferredDevice;
      try {
        transcriber = await mod.pipeline('automatic-speech-recognition', targetModel, buildOpts(preferredDevice));
      } catch (primaryErr) {
        if (preferredDevice !== 'wasm') {
          activeDevice = 'wasm';
          transcriber = await mod.pipeline('automatic-speech-recognition', targetModel, buildOpts('wasm'));
        } else {
          throw primaryErr;
        }
      }

      await inspectWhisperCache(targetModel);
      return { transcriber, device: activeDevice, modelId: targetModel };
    })().catch((err) => {
      cachedPipelinePromises.delete(cacheKey);
      throw err;
    });

    cachedPipelinePromises.set(cacheKey, loaderPromise);
    return loaderPromise;
  }

  async function preloadWhisperModel(modelId, onProgress) {
    const profile = getDeviceAndNetworkSttProfile();
    if (!profile.whisperSupported) {
      return { ok: false, error: 'This device does not support WebAssembly/AudioContext offline Whisper.' };
    }
    const targetModel = normalizeWhisperModel(modelId || profile.whisperModel);
    try {
      const res = await getWhisperPipeline(targetModel, { onProgress });
      lastWhisperCacheStatus = { checkedAt: Date.now(), modelId: targetModel, cached: true };
      return { ok: true, modelId: res.modelId, device: res.device };
    } catch (err) {
      return { ok: false, error: err?.message || 'Failed to preload Whisper model' };
    }
  }

  async function callCloudSttEndpoint(audioBlob, modeHint = '') {
    const apiUrl = typeof global.getApiUrl === 'function' ? global.getApiUrl('api/stt') : '/api/stt';
    const formData = new FormData();
    formData.append('file', audioBlob, 'speech.webm');
    if (modeHint) formData.append('mode', modeHint);

    const headers = {};
    try {
      const k = localStorage.getItem('cf_eleven_key') || global.STATE?.config?.eleven_key || '';
      if (k && k !== 'configured') headers['xi-api-key'] = k.split(/[\r\n,]+/)[0].trim();
    } catch {}

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const res = await fetch(apiUrl, { method: 'POST', headers, body: formData, signal: ctrl.signal });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      if (data && data.ok) {
        const cleaned = stripWhisperNoiseTags(data.text || '');
        return {
          ok: true,
          text: hasSpeechWords(cleaned) ? cleaned : '',
          words: Array.isArray(data.words) ? data.words : [],
          provider: data.provider || 'Cloud Scribe STT'
        };
      }
      return { ok: false, error: data?.error || 'Cloud STT returned non-ok response' };
    } catch (err) {
      return { ok: false, error: err?.message || 'Cloud STT network error' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function transcribeAudioWithWhisperOffline(audioBlob, opts = {}) {
    if (!audioBlob || audioBlob.size < 250) {
      return { ok: true, text: '', silent: true, provider: 'Offline Whisper AI (Silence Guard)' };
    }

    let decoded = null;
    try {
      decoded = await decodeAudioBlobTo16kHzMono(audioBlob);
      // Strict acoustic silence guard before invoking Whisper (prevents phantom "Thank you." hallucinations)
      if (!decoded || decoded.pcm.length < 3200 || (decoded.peak < 0.008 && decoded.rms < 0.0025)) {
        return { ok: true, text: '', silent: true, provider: 'Offline Whisper AI (Silence Guard)' };
      }
    } catch (decodeErr) {
      return { ok: false, error: `Audio decode error: ${decodeErr.message}` };
    }

    // 1. Optional VoiceForge local offline daemon probe (127.0.0.1:8765/stt)
    const vfResult = await tryVoiceForgeLocalStt(audioBlob);
    if (vfResult && vfResult.ok) return vfResult;

    // 2. Browser On-Device Whisper (Transformers.js WASM / WebGPU)
    const profile = getDeviceAndNetworkSttProfile();
    if (!profile.whisperSupported) {
      return { ok: false, error: 'Offline Whisper unsupported on this device hardware.' };
    }

    try {
      const { transcriber, device, modelId } = await getWhisperPipeline(opts.modelId || profile.whisperModel, {
        onProgress: opts.onProgress
      });
      const out = await transcriber(decoded.pcm, {
        chunk_length_s: 20,
        stride_length_s: 4,
        return_timestamps: false
      });
      const rawText = typeof out === 'string' ? out : (out?.text || '');
      let cleaned = stripWhisperNoiseTags(rawText);

      // Guard classic low-energy Whisper hallucinations ("thank you", "you") on very quiet room hiss
      if (decoded.rms < 0.012 && /^(thank you\.?|thanks\.?|you\.?|bye\.?)$/i.test(cleaned)) {
        cleaned = '';
      }

      return {
        ok: true,
        text: hasSpeechWords(cleaned) ? cleaned : '',
        silent: !hasSpeechWords(cleaned),
        modelId,
        provider: `Offline Whisper AI (${String(device || 'wasm').toUpperCase()})`
      };
    } catch (err) {
      return { ok: false, error: err?.message || 'Offline Whisper inference error' };
    }
  }

  async function transcribeAudioBlob(audioBlob, opts = {}) {
    const strategy = opts.strategy || resolveSttStrategy({ mode: opts.mode });

    if (strategy.activeEngine === 'cloud-elevenlabs' && strategy.profile.online) {
      const cloudRes = await callCloudSttEndpoint(audioBlob);
      if (cloudRes && cloudRes.ok) return cloudRes;
      if (strategy.useAudioSegmentWhisper && strategy.profile.whisperSupported) {
        const offlineRes = await transcribeAudioWithWhisperOffline(audioBlob, opts);
        if (offlineRes && offlineRes.ok) {
          return Object.assign({}, offlineRes, {
            provider: `${offlineRes.provider} · Failover`
          });
        }
      }
      return cloudRes;
    }

    if (strategy.activeEngine === 'whisper-offline' || strategy.useAudioSegmentWhisper) {
      return await transcribeAudioWithWhisperOffline(audioBlob, opts);
    }

    if (strategy.profile.online && strategy.useCloudStt) {
      return await callCloudSttEndpoint(audioBlob);
    }

    return { ok: false, error: 'No offline or online audio STT engine available.' };
  }

  function updateAdminSttRuntimeUi() {
    const statusEl = document.getElementById('admin-stt-runtime-status');
    const pillEl = document.getElementById('admin-stt-route-pill');
    const strategy = resolveSttStrategy();
    const p = strategy.profile;

    if (pillEl) {
      pillEl.textContent = strategy.badgeLabel;
    }
    if (statusEl) {
      const memText = p.deviceMemoryGB ? `${p.deviceMemoryGB} GB RAM` : 'Standard RAM';
      const netText = p.online ? `Online (${p.effectiveType.toUpperCase()}${p.saveData ? ' · Save-Data' : ''})` : 'Offline';
      const cacheText = p.cachedModelReady ? 'Whisper Cached ✓' : 'Whisper On-Demand';
      statusEl.innerHTML =
        `<strong>Active Route:</strong> ${strategy.badgeLabel}<br>` +
        `<span>${netText} · ${memText} · ${p.cpuCores} Cores · WASM ${p.hasWasm ? '✓' : '✕'} · WebGPU ${p.hasWebGPU ? '✓' : '—'} · ${cacheText}</span><br>` +
        `<span style="color:var(--text-dim);">${strategy.reason}</span>`;
    }
  }

  // Expose public API
  const CareerFairSTT = {
    ALLOWED_STT_MODES,
    ALLOWED_WHISPER_MODELS,
    normalizeSttMode,
    normalizeWhisperModel,
    stripWhisperNoiseTags,
    hasSpeechWords,
    getDeviceAndNetworkSttProfile,
    inspectWhisperCache,
    resolveSttStrategy,
    decodeAudioBlobTo16kHzMono,
    transcribeAudioWithWhisperOffline,
    callCloudSttEndpoint,
    transcribeAudioBlob,
    preloadWhisperModel,
    updateAdminSttRuntimeUi
  };

  global.CareerFairSTT = CareerFairSTT;

  // Refresh Admin telemetry dynamically on network transitions
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('online', () => { try { updateAdminSttRuntimeUi(); } catch {} });
    global.addEventListener('offline', () => { try { updateAdminSttRuntimeUi(); } catch {} });
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      inspectWhisperCache().then(() => updateAdminSttRuntimeUi()).catch(() => updateAdminSttRuntimeUi());
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
