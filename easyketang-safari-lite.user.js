// ==UserScript==
// @name         Easy云课堂·极简移动版 (iOS Safari)
// @namespace    easyketang-safari-lite
// @version      1.0.0
// @description  专为 iOS Safari 打造的 Easy云课堂极简移动端界面：全课程自动拉取、三级目录保留滚动进度、原生 HLS 播放、倍速与断点记忆、授权视频本地保存
// @license      MIT
// @match        *://*.easyketang.com/*
// @match        *://easyketang.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (window.top !== window.self) return;

    // 提前保存原生 fetch，脚本自身请求走原生通道，不触发拦截器
    const rawFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

    // ====== 1. 常量与运行状态 ======
    const STORAGE_KEYS = {
        rate: 'ek_v4_rate',
        lastCourse: 'ek_v4_last_course',
        lastPlayed: 'ek_v4_last_played',
        progress: 'ek_v4_progress'
    };

    // 清理早期版本（v0.1~v0.4）可能遗留的 token 键（本版永不读写任何本地 token）
    ['ek_mvp_token', 'ek_v3_token', 'ek_v4_token'].forEach(k => {
        try { sessionStorage.removeItem(k); } catch (e) { }
        try { localStorage.removeItem(k); } catch (e) { }
    });

    const DL_LIMIT = 512 * 1024 * 1024;
    const DL_WARN_LIMIT = 200 * 1024 * 1024;
    const DL_PART_LIMIT = 24 * 1024 * 1024;
    const DL_MEDIA_LIB_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1.66.0/dist/bundles/mediabunny.min.mjs';
    // 可选供应链加固：填入 mediabunny.min.mjs 的真实 SHA-256（64 位小写十六进制）即可开启强制完整性校验
    const DL_MEDIA_LIB_SHA256 = '';
    let dlSource = null, dlJob = null, dlFile = null, dlObjectUrl = '', dlPreviewUrl = '';
    let dlCloseConfirmTimer = null, dlCloseConfirmPending = false;
    const dlEl = id => document.getElementById(id);
    const dlFail = msg => { throw new Error(msg); };
    let capturedToken = '';
    let lastLoadedToken = '';
    let originalViewportContent = null;
    let isOverlayOpen = false;

    let currentView = 'courses'; // 'courses' | 'tasks' | 'detail'
    let coursesCache = [];
    let passiveCourses = {};
    let activeCourse = null;
    let loadedCourseKey = '';
    let tasksCache = [];

    let currentVideos = [];
    let currentVideoIndex = -1;
    let preferredRate = parseFloat(localStorage.getItem(STORAGE_KEYS.rate)) || 1.0;

    let toastTimer = null;
    let activePlayRequestId = 0;
    let activeTaskReqId = 0;
    let activeDetailReqId = 0;
    let hasRestoredTime = false;
    let lastProgressSaveTs = 0;
    let courseSearchQuery = '';

    // ====== 2. 公开页 / 登录页识别与会话销毁 ======
    function isElementVisible(el) {
        if (!el || el.closest('#ek-root') || el.closest('#ek-player-modal')) return false;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
            return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function getNormalizedRoutes() {
        const path = (window.location.pathname || '').toLowerCase().replace(/\/+$/, '');
        const hashPath = (window.location.hash || '')
            .replace(/^#/, '')
            .split('?')[0]
            .toLowerCase()
            .replace(/\/+$/, '');
        return { path, hashPath };
    }

    // 官网宣传落地页（如 https://www.easyketang.com/#/index、根路径 #/、关于/定价等）
    function isPublicLandingRoute() {
        const { path, hashPath } = getNormalizedRoutes();
        if (!hashPath && (path === '' || path === '/index' || path === '/index.html')) {
            return true;
        }
        if (/^\/?(index|about|price|pricing|try|apply)$/.test(hashPath)) {
            return true;
        }
        return false;
    }

    // 登录 / 注册 / 找回密码路由
    function isAuthRoute() {
        const { path, hashPath } = getNormalizedRoutes();
        const authRe = /^\/?(login|signin|register|signup|forget|forgot|reset)(\/|$)/;
        return authRe.test(hashPath) || authRe.test(path);
    }

    function hasVisibleLoginForm() {
        if (!document.body) return false;
        const pwdInputs = document.querySelectorAll('input[type="password"]');
        const visiblePwds = [];
        for (const input of pwdInputs) {
            if (isElementVisible(input)) visiblePwds.push(input);
        }
        if (visiblePwds.length !== 1) return false;

        const ph = (visiblePwds[0].getAttribute('placeholder') || '').trim();
        if (/原密码|旧密码|新密码|确认/.test(ph)) return false;

        return true;
    }

    function isOnPublicOrAuthPage() {
        return isPublicLandingRoute() || isAuthRoute() || hasVisibleLoginForm();
    }

    function isValidTokenStr(val) {
        if (typeof val !== 'string') return false;
        const s = val.replace(/^"|"$/g, '').trim();
        if (s.length < 8 || s.length > 128) return false;
        if (/^(null|undefined|false|true)$/i.test(s)) return false;
        return true;
    }

    function resetAuthSession() {
        dlReset();
        capturedToken = '';
        lastLoadedToken = '';
        coursesCache = [];
        passiveCourses = {};
        activeCourse = null;
        loadedCourseKey = '';
        tasksCache = [];
        currentVideos = [];
        currentVideoIndex = -1;
        courseSearchQuery = '';

        ['ek-view-courses', 'ek-view-tasks', 'ek-view-detail'].forEach(id => {
            const el = document.getElementById(id);
            if (el && el.innerHTML) el.innerHTML = '';
        });
    }

    function getToken() {
        if (isOnPublicOrAuthPage()) {
            resetAuthSession();
            return '';
        }
        return capturedToken || '';
    }

    function acceptLiveToken(token) {
        if (!isValidTokenStr(token)) return;
        // 在官网宣传页（#/index 等）完全忽略后台携带的旧 token
        if (isPublicLandingRoute()) return;

        const clean = token.trim();
        const apply = () => {
            if (isOnPublicOrAuthPage()) return;
            if (capturedToken && capturedToken !== clean) dlReset();
            capturedToken = clean;
            syncLoginVisibility();
        };

        if (isOnPublicOrAuthPage()) {
            // 刚在 #/login 提交登录、页面正在切往工作台路由时的短暂过渡重检
            setTimeout(apply, 300);
            setTimeout(apply, 850);
        } else {
            apply();
        }
    }

    function syncLoginVisibility() {
        const fab = document.getElementById('ek-fab');
        const root = document.getElementById('ek-root');
        if (!fab || !root) return;

        const isLoggedIn = Boolean(capturedToken) && !isOnPublicOrAuthPage();

        if (!isLoggedIn) {
            if (capturedToken || coursesCache.length > 0 || isOverlayOpen) {
                resetAuthSession();
            }
            if (isOverlayOpen) {
                closePlayer();
                isOverlayOpen = false;
                root.style.display = 'none';
                setMobileViewport(false);
            }
            fab.style.display = 'none';
        } else if (!isOverlayOpen) {
            fab.style.display = 'block';
        }
    }

    // 监听原网页清除存储行为（退出登录时立即同步清理）
    function hookStorage() {
        try {
            const origRemove = Storage.prototype.removeItem;
            Storage.prototype.removeItem = function (key) {
                const ret = origRemove.apply(this, arguments);
                if (typeof key === 'string' && !key.startsWith('ek_') && /token|user|auth|login/i.test(key)) {
                    resetAuthSession();
                    setTimeout(syncLoginVisibility, 0);
                }
                return ret;
            };

            const origClear = Storage.prototype.clear;
            Storage.prototype.clear = function () {
                const ret = origClear.apply(this, arguments);
                resetAuthSession();
                setTimeout(syncLoginVisibility, 0);
                return ret;
            };
        } catch (e) { }
    }
    hookStorage();

    // ====== 3. 个人偏好存储（不存任何账号或 Token） ======
    function readJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function writeJson(key, val) {
        try {
            localStorage.setItem(key, JSON.stringify(val));
        } catch (e) { }
    }

    function getVideoProgress(resourceId) {
        const map = readJson(STORAGE_KEYS.progress, {});
        return map[String(resourceId)] || null;
    }

    function saveVideoProgress(resourceId, time, duration) {
        if (!resourceId) return;
        const map = readJson(STORAGE_KEYS.progress, {});
        const key = String(resourceId);

        if (duration > 0 && time >= duration - 5) {
            delete map[key];
        } else if (time >= 5) {
            map[key] = {
                time: Math.floor(time),
                duration: Math.floor(duration || 0),
                updatedAt: Date.now()
            };
        }

        const entries = Object.entries(map);
        if (entries.length > 100) {
            entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
            writeJson(STORAGE_KEYS.progress, Object.fromEntries(entries.slice(0, 100)));
        } else {
            writeJson(STORAGE_KEYS.progress, map);
        }
    }

    // ====== 4. 静默监听实时 XHR / Fetch（只认工作台内服务端确认有效的会话） ======
    function parseEasyApiUrl(rawUrl) {
        if (typeof rawUrl !== 'string' || !rawUrl) return null;
        try {
            const parsed = new URL(rawUrl, window.location.origin);
            if (!/(^|\.)easyketang\.com$/i.test(parsed.hostname)) return null;
            return parsed;
        } catch (e) {
            return null;
        }
    }

    function isLogoutPath(pathname) {
        return /logout|login_out|loginout/i.test(pathname || '');
    }

    function isAuthProofPath(pathname) {
        const p = (pathname || '').toLowerCase();
        if (!p) return false;
        if (/\/(login|logout|login_out|get_lang|get-setting|get_captcha|getwebconfig)(\/|$)/.test(p)) return false;
        return true;
    }

    function handleVerifiedResponse(parsed, json) {
        if (!parsed || !json || typeof json !== 'object') return;
        if (isPublicLandingRoute()) return;

        const path = parsed.pathname || '';
        const params = parsed.searchParams;
        const token = params.get('token');

        if (json.status === 1) {
            if (isValidTokenStr(token) && isAuthProofPath(path)) {
                acceptLiveToken(token);
            }
            if (path.includes('/admin/task_lite/new_query')) {
                const cid = params.get('course_id');
                if (cid) {
                    passiveCourses[String(cid)] = {
                        courseId: String(cid),
                        courseName: `课程 #${cid}`,
                        planId: params.get('plan_id') || '',
                        classId: '0',
                        semesterId: 0,
                        semesterLabel: '最近访问',
                        isCurrent: false,
                        teachers: '',
                        hours: 0,
                        recentTime: ''
                    };
                }
            }
        } else if (json.message && /登录|token|过期|失效/i.test(String(json.message))) {
            resetAuthSession();
            syncLoginVisibility();
        }
    }

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
        this._ekParsedUrl = parseEasyApiUrl(url);
        if (this._ekParsedUrl && isLogoutPath(this._ekParsedUrl.pathname)) {
            resetAuthSession();
            setTimeout(syncLoginVisibility, 0);
        }
        return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
        const parsed = this._ekParsedUrl;
        if (parsed && parsed.searchParams.get('token') && !isLogoutPath(parsed.pathname)) {
            this.addEventListener('load', function () {
                if (this.status !== 200) return;
                try {
                    let json = null;
                    if (this.responseType === 'json') {
                        json = this.response;
                    } else if (this.responseType === '' || this.responseType === 'text') {
                        const text = (this.responseText || '').trim();
                        if (text.startsWith('{')) json = JSON.parse(text);
                    }
                    if (json) handleVerifiedResponse(parsed, json);
                } catch (e) { }
            });
        }
        return origSend.apply(this, arguments);
    };

    if (rawFetch) {
        window.fetch = function (input, init) {
            const rawUrl = typeof input === 'string' ? input : (input && input.url);
            const parsed = parseEasyApiUrl(rawUrl);
            if (parsed && isLogoutPath(parsed.pathname)) {
                resetAuthSession();
                setTimeout(syncLoginVisibility, 0);
            }
            const promise = rawFetch(input, init);
            if (parsed && parsed.searchParams.get('token') && !isLogoutPath(parsed.pathname)) {
                promise.then(res => {
                    if (!res || !res.ok) return;
                    return res.clone().json().then(json => handleVerifiedResponse(parsed, json)).catch(() => { });
                }).catch(() => { });
            }
            return promise;
        };
    }

    // ====== 5. 通用工具函数 ======
    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function findResMetaById(resourceId) {
        const targetId = String(resourceId ?? '');
        const items = document.querySelectorAll('#ek-view-detail .ek-res-item');
        for (const el of items) {
            if (el.dataset.resId === targetId) {
                return el.querySelector('.ek-res-meta');
            }
        }
        return null;
    }

    function formatDuration(sec) {
        const s = Math.floor(Number(sec) || 0);
        if (s <= 0) return '';
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        if (h > 0) {
            return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
        }
        return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    }

    function showToast(msg, duration = 2200) {
        const el = document.getElementById('ek-toast');
        if (!el) return;
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), duration);
    }

    function setMobileViewport(enable) {
        let meta = document.querySelector('meta[name="viewport"]');
        if (enable) {
            if (!meta) {
                meta = document.createElement('meta');
                meta.name = 'viewport';
                document.head.appendChild(meta);
                originalViewportContent = '';
            } else if (originalViewportContent === null) {
                originalViewportContent = meta.getAttribute('content') || '';
            }
            meta.setAttribute(
                'content',
                'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'
            );
        } else if (meta && originalViewportContent !== null) {
            meta.setAttribute('content', originalViewportContent);
        }
    }

    // ====== 6. 注入样式 ======
    function injectStyles() {
        if (document.getElementById('ek-v4-style')) return;
        const style = document.createElement('style');
        style.id = 'ek-v4-style';
        style.textContent = `
      #ek-fab {
        position: fixed;
        right: 16px;
        bottom: calc(84px + env(safe-area-inset-bottom, 0px));
        z-index: 2147483640;
        background: #007aff;
        color: #fff;
        border: none;
        border-radius: 999px;
        padding: 12px 18px;
        font-size: 16px;
        font-weight: 600;
        box-shadow: 0 6px 20px rgba(0, 122, 255, 0.38);
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      #ek-root {
        position: fixed;
        inset: 0;
        z-index: 2147483644;
        background: #f2f2f7;
        color: #1c1c1e;
        display: none;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
        font-size: 15px;
        line-height: 1.45;
        box-sizing: border-box;
      }
      #ek-root *, #ek-player-modal * { box-sizing: border-box; }
      .ek-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: calc(10px + env(safe-area-inset-top, 0px)) 12px 10px;
        background: rgba(255, 255, 255, 0.94);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border-bottom: 1px solid #e5e5ea;
        flex-shrink: 0;
      }
      .ek-title {
        font-size: 16px;
        font-weight: 700;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 56%;
        text-align: center;
      }
      .ek-btn-text {
        background: none;
        border: none;
        color: #007aff;
        font-size: 15px;
        font-weight: 500;
        padding: 6px 8px;
        cursor: pointer;
        white-space: nowrap;
        -webkit-tap-highlight-color: transparent;
      }
      .ek-scroll {
        flex: 1;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        padding: 12px 14px calc(36px + env(safe-area-inset-bottom, 0px));
      }
      .ek-search-wrap {
        margin-bottom: 12px;
      }
      .ek-search-input {
        width: 100%;
        padding: 10px 14px;
        border-radius: 12px;
        border: 1px solid #e5e5ea;
        background: #fff;
        font-size: 15px;
        color: #1c1c1e;
        outline: none;
        -webkit-appearance: none;
      }
      .ek-search-input:focus {
        border-color: #007aff;
      }
      .ek-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12px;
        color: #8e8e93;
        margin: 0 4px 10px;
      }
      .ek-mini-btn {
        background: #e5e5ea;
        color: #1c1c1e;
        border: none;
        border-radius: 8px;
        padding: 5px 11px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .ek-card {
        background: #fff;
        border-radius: 14px;
        padding: 14px 16px;
        margin-bottom: 12px;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
      }
      .ek-course-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
      }
      .ek-course-card:active, .ek-task-item:active, .ek-res-item:active {
        background: #ececf0;
      }
      .ek-course-name {
        font-size: 16px;
        font-weight: 700;
        color: #1c1c1e;
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .ek-course-sub {
        font-size: 12px;
        color: #8e8e93;
        margin-top: 5px;
      }
      .ek-primary-btn {
        width: 100%;
        margin-top: 14px;
        padding: 11px 14px;
        border: none;
        border-radius: 11px;
        background: #007aff;
        color: #fff;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
      }
      .ek-task-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
      }
      .ek-badge {
        display: inline-block;
        font-size: 12px;
        padding: 3px 9px;
        border-radius: 999px;
        background: #e5f1ff;
        color: #007aff;
        font-weight: 600;
        flex-shrink: 0;
        margin-left: 10px;
      }
      .ek-badge.done {
        background: #e4f7ea;
        color: #248a3d;
      }
      .ek-section-title {
        font-size: 13px;
        font-weight: 600;
        color: #6e6e73;
        margin: 16px 4px 8px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .ek-section-title:first-child { margin-top: 2px; }
      .ek-sem-curr {
        font-size: 11px;
        background: #e4f7ea;
        color: #248a3d;
        padding: 1px 7px;
        border-radius: 999px;
        font-weight: 600;
      }
      .ek-res-list {
        background: #fff;
        border-radius: 14px;
        overflow: hidden;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
      }
      .ek-res-item {
        display: flex;
        align-items: center;
        padding: 13px 14px;
        border-bottom: 1px solid #f2f2f7;
        cursor: pointer;
      }
      .ek-res-item:last-child { border-bottom: none; }
      .ek-res-icon {
        font-size: 20px;
        margin-right: 12px;
        flex-shrink: 0;
      }
      .ek-res-info {
        flex: 1;
        min-width: 0;
      }
      .ek-res-name {
        font-size: 15px;
        font-weight: 500;
        color: #1c1c1e;
        word-break: break-word;
      }
      .ek-res-meta {
        font-size: 12px;
        color: #8e8e93;
        margin-top: 3px;
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .ek-tag {
        font-size: 11px;
        padding: 1px 6px;
        border-radius: 6px;
        font-weight: 600;
      }
      .ek-last-tag { background: #007aff; color: #fff; }
      .ek-resume-tag { background: #ffefe0; color: #c95f00; }

      /* 播放器弹窗 */
      #ek-player-modal {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        background: #000;
        color: #fff;
        display: none;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      }
      .ek-player-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: calc(10px + env(safe-area-inset-top, 0px)) 14px 10px;
        background: #1c1c1e;
        flex-shrink: 0;
      }
      .ek-player-title {
        font-size: 15px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 72%;
      }
      .ek-video-wrap {
        width: 100%;
        background: #000;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 210px;
      }
      #ek-video {
        width: 100%;
        max-height: 44vh;
        background: #000;
      }
      .ek-controls {
        padding: 16px 16px calc(24px + env(safe-area-inset-bottom, 0px));
        background: #1c1c1e;
        flex: 1;
        overflow-y: auto;
      }
      .ek-control-label {
        font-size: 13px;
        color: #8e8e93;
        margin-bottom: 8px;
      }
      .ek-speed-row {
        display: flex;
        gap: 8px;
        margin-bottom: 18px;
      }
      .ek-pill {
        flex: 1;
        padding: 9px 0;
        border-radius: 10px;
        border: 1px solid #3a3a3c;
        background: #2c2c2e;
        color: #fff;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
      }
      .ek-pill.active {
        background: #007aff;
        border-color: #007aff;
      }
      .ek-action-row {
        display: flex;
        gap: 10px;
        margin-bottom: 12px;
      }
      .ek-action-btn {
        flex: 1;
        padding: 12px 10px;
        border-radius: 12px;
        border: none;
        background: #30d158;
        color: #000;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
      }
      .ek-action-btn.secondary {
        background: #2c2c2e;
        color: #fff;
        border: 1px solid #3a3a3c;
      }
      .ek-action-btn:disabled { opacity: 0.38; }
      #ek-player-log {
        margin-top: 12px;
        font-size: 12px;
        color: #a1a1a6;
        line-height: 1.5;
      }

      /* 自绘 Toast */
      #ek-toast {
        position: fixed;
        left: 50%;
        bottom: calc(36px + env(safe-area-inset-bottom, 0px));
        transform: translateX(-50%) translateY(16px);
        z-index: 2147483647;
        background: rgba(28, 28, 30, 0.92);
        color: #fff;
        padding: 10px 18px;
        border-radius: 999px;
        font-size: 14px;
        max-width: 86vw;
        text-align: center;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease, transform 0.2s ease;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      }
      #ek-toast.show {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    `;
        document.head.appendChild(style);
    }

    // ====== 7. 构建 UI 骨架 ======
    function buildUI() {
        if (!document.body || document.getElementById('ek-fab')) return;
        injectStyles();

        const fab = document.createElement('button');
        fab.id = 'ek-fab';
        fab.textContent = '📱 极简模式';
        fab.style.display = 'none';
        fab.addEventListener('click', openMobileOverlay);
        document.body.appendChild(fab);

        const root = document.createElement('div');
        root.id = 'ek-root';
        root.style.display = 'none';
        root.innerHTML = `
      <div class="ek-header">
        <button class="ek-btn-text" id="ek-left-btn">🔄 刷新</button>
        <div class="ek-title" id="ek-header-title">我的课程</div>
        <button class="ek-btn-text" id="ek-close-btn">原网页</button>
      </div>
      <div class="ek-scroll" id="ek-view-courses"></div>
      <div class="ek-scroll" id="ek-view-tasks" style="display:none;"></div>
      <div class="ek-scroll" id="ek-view-detail" style="display:none;"></div>
    `;
        document.body.appendChild(root);

        const modal = document.createElement('div');
        modal.id = 'ek-player-modal';
        modal.innerHTML = `
      <div class="ek-player-bar">
        <div class="ek-player-title" id="ek-player-title">视频加载中...</div>
        <button class="ek-btn-text" id="ek-player-close" style="color:#ff453a;">关闭</button>
      </div>
      <div class="ek-video-wrap">
        <video id="ek-video" controls playsinline webkit-playsinline preload="metadata"></video>
      </div>
      <div class="ek-controls">
        <div class="ek-control-label">播放倍速（iOS 原生流畅档位，自动记忆）</div>
        <div class="ek-speed-row" id="ek-speed-row">
          ${[1.0, 1.25, 1.5, 1.75, 2.0]
                .map(r => `<button class="ek-pill ${r === preferredRate ? 'active' : ''}" data-rate="${r}">${r}x</button>`)
                .join('')}
        </div>
        <div class="ek-action-row">
          <button class="ek-action-btn" id="ek-btn-fullscreen">📺 原生全屏</button>
          <button class="ek-action-btn secondary" id="ek-btn-pip">🪟 画中画</button>
        </div>
        <div class="ek-action-row">
          <button class="ek-action-btn secondary" id="ek-btn-prev">⏮ 上一节</button>
          <button class="ek-action-btn secondary" id="ek-btn-next">下一节 ⏭</button>
        </div>
        <div id="ek-player-log">状态：准备就绪</div>
        <div style="border-top:1px solid #3a3a3c;margin-top:16px;padding-top:14px;">
          <div class="ek-control-label">视频下载 · 仅限获授权离线保存的内容</div>
          <div class="ek-action-row">
            <button class="ek-action-btn" id="ek-dl-start" disabled>下载完整视频</button>
            <button class="ek-action-btn secondary" id="ek-dl-cancel" hidden>取消</button>
          </div>
          <progress id="ek-dl-progress" max="100" value="0" style="width:100%;height:8px;accent-color:#007aff;"></progress>
          <div id="ek-dl-status" style="font-size:12px;color:#a1a1a6;margin:8px 0;overflow-wrap:anywhere;">视频地址就绪后可下载</div>
          <div class="ek-action-row">
            <button class="ek-action-btn" id="ek-dl-save" hidden>保存 MP4</button>
            <button class="ek-action-btn secondary" id="ek-dl-share" hidden>系统分享</button>
          </div>
          <button class="ek-action-btn secondary" id="ek-dl-preview" hidden style="width:100%;margin-bottom:8px;">预览生成的 MP4（保存前检查）</button>
          <video id="ek-dl-preview-video" controls playsinline webkit-playsinline preload="metadata" style="display:none;width:100%;max-height:38vh;background:#000;"></video>
          <div style="font-size:12px;color:#8e8e93;">下载时请保持 Safari 前台，勿切换视频；单文件上限 512 MiB（超过 200 MiB 在 iOS 上内存压力较大）。</div>
        </div>
      </div>
    `;
        document.body.appendChild(modal);

        const toast = document.createElement('div');
        toast.id = 'ek-toast';
        document.body.appendChild(toast);

        // 导航事件
        document.getElementById('ek-close-btn').addEventListener('click', closeMobileOverlay);
        document.getElementById('ek-left-btn').addEventListener('click', () => {
            if (currentView === 'detail') {
                switchView('tasks');
            } else if (currentView === 'tasks') {
                switchView('courses');
            } else {
                loadCourses(true);
                showToast('正在刷新课程列表...');
            }
        });

        // 播放器事件（下载中二次确认关闭，防误触）
        document.getElementById('ek-player-close').addEventListener('click', () => {
            if (dlJob && !dlCloseConfirmPending) {
                dlCloseConfirmPending = true;
                const closeBtn = dlEl('ek-player-close');
                if (closeBtn) closeBtn.textContent = '确认关闭';
                showToast('视频正在下载，再点一次「确认关闭」将中止下载', 3000);
                clearTimeout(dlCloseConfirmTimer);
                dlCloseConfirmTimer = setTimeout(dlResetCloseConfirm, 3000);
                return;
            }
            dlResetCloseConfirm();
            closePlayer();
        });
        dlEl('ek-dl-start').addEventListener('click', dlStart);
        dlEl('ek-dl-cancel').addEventListener('click', () => { if (dlJob) dlJob.controller.abort(); });
        dlEl('ek-dl-save').addEventListener('click', dlSave);
        dlEl('ek-dl-share').addEventListener('click', dlShare);
        dlEl('ek-dl-preview').addEventListener('click', dlPreview);
        dlButtons();
        const video = document.getElementById('ek-video');
        const logEl = document.getElementById('ek-player-log');

        document.getElementById('ek-speed-row').addEventListener('click', (e) => {
            const btn = e.target.closest('.ek-pill');
            if (!btn) return;
            preferredRate = parseFloat(btn.dataset.rate);
            localStorage.setItem(STORAGE_KEYS.rate, String(preferredRate));
            video.playbackRate = preferredRate;
            updateSpeedPills();
            showToast(`已切换为 ${preferredRate}x 倍速`);
        });

        document.getElementById('ek-btn-fullscreen').addEventListener('click', () => {
            if (typeof video.webkitEnterFullscreen === 'function') {
                video.webkitEnterFullscreen();
            } else if (video.requestFullscreen) {
                video.requestFullscreen();
            } else {
                showToast('请先点击画面开始播放，再点原生全屏');
            }
        });

        document.getElementById('ek-btn-pip').addEventListener('click', () => {
            if (typeof video.webkitSetPresentationMode === 'function') {
                const mode = video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture';
                video.webkitSetPresentationMode(mode);
            } else {
                showToast('全屏播放后直接上滑返回桌面即可进入画中画');
            }
        });

        document.getElementById('ek-btn-prev').addEventListener('click', () => {
            if (dlJob) return showToast('视频正在下载，请等待完成或先点击取消');
            if (currentVideoIndex > 0) playVideoByIndex(currentVideoIndex - 1);
        });
        document.getElementById('ek-btn-next').addEventListener('click', () => {
            if (dlJob) return showToast('视频正在下载，请等待完成或先点击取消');
            if (currentVideoIndex >= 0 && currentVideoIndex < currentVideos.length - 1) {
                playVideoByIndex(currentVideoIndex + 1);
            }
        });

        const syncRateAndResume = () => {
            if (video.playbackRate !== preferredRate) {
                video.playbackRate = preferredRate;
            }
            const item = currentVideos[currentVideoIndex];
            if (!hasRestoredTime && item) {
                const saved = getVideoProgress(item.resourceId);
                const dur = Number(video.duration) || item.duration || 0;
                if (saved && saved.time >= 5 && (dur === 0 || saved.time < dur - 8)) {
                    try {
                        video.currentTime = saved.time;
                        hasRestoredTime = true;
                        logEl.textContent = `已续播至 ${formatDuration(saved.time)} · 时长 ${formatDuration(dur)} · ${preferredRate}x`;
                        return;
                    } catch (e) { }
                }
                hasRestoredTime = true;
            }
        };

        video.addEventListener('loadedmetadata', () => {
            syncRateAndResume();
            if (!logEl.textContent.startsWith('已续播')) {
                logEl.textContent = `已就绪 · 时长 ${formatDuration(video.duration)} · 当前 ${preferredRate}x 倍速`;
            }
        });
        video.addEventListener('canplay', syncRateAndResume);
        video.addEventListener('playing', () => {
            if (video.playbackRate !== preferredRate) video.playbackRate = preferredRate;
        });

        const persistCurrentProgress = (force = false) => {
            const item = currentVideos[currentVideoIndex];
            if (!item || !video.currentTime) return;
            const now = Date.now();
            if (!force && now - lastProgressSaveTs < 3000) return;
            lastProgressSaveTs = now;
            saveVideoProgress(item.resourceId, video.currentTime, video.duration || item.duration || 0);
        };

        video.addEventListener('timeupdate', () => persistCurrentProgress(false));
        video.addEventListener('pause', () => persistCurrentProgress(true));
        video.addEventListener('ended', () => {
            const item = currentVideos[currentVideoIndex];
            if (item) saveVideoProgress(item.resourceId, video.duration || 999999, video.duration || 1);
        });
        video.addEventListener('error', () => {
            const code = video.error ? video.error.code : 'unknown';
            logEl.textContent = `播放异常 (code=${code})，请尝试关闭重试或刷新网页更新登录态。`;
        });

        syncLoginVisibility();
    }

    function updateSpeedPills() {
        document.querySelectorAll('#ek-speed-row .ek-pill').forEach(btn => {
            btn.classList.toggle('active', parseFloat(btn.dataset.rate) === preferredRate);
        });
    }

    function updateNavButtons() {
        const prev = document.getElementById('ek-btn-prev');
        const next = document.getElementById('ek-btn-next');
        if (prev) prev.disabled = Boolean(dlJob) || currentVideoIndex <= 0;
        if (next) next.disabled = Boolean(dlJob) || currentVideoIndex < 0 || currentVideoIndex >= currentVideos.length - 1;
    }

    // ====== 8. 三级视图切换 ======
    function switchView(view, titleOverride) {
        currentView = view;
        document.getElementById('ek-view-courses').style.display = view === 'courses' ? 'block' : 'none';
        document.getElementById('ek-view-tasks').style.display = view === 'tasks' ? 'block' : 'none';
        document.getElementById('ek-view-detail').style.display = view === 'detail' ? 'block' : 'none';

        const leftBtn = document.getElementById('ek-left-btn');
        const titleEl = document.getElementById('ek-header-title');

        if (view === 'courses') {
            leftBtn.textContent = '🔄 刷新';
            titleEl.textContent = '我的课程';
        } else if (view === 'tasks') {
            leftBtn.textContent = '‹ 课程';
            titleEl.textContent = titleOverride || (activeCourse ? activeCourse.courseName : '课程目录');
        } else if (view === 'detail') {
            leftBtn.textContent = '‹ 目录';
            if (titleOverride) titleEl.textContent = titleOverride;
        }
    }

    function openMobileOverlay() {
        const token = getToken();
        if (!token || isOnPublicOrAuthPage()) {
            syncLoginVisibility();
            return;
        }

        isOverlayOpen = true;
        setMobileViewport(true);
        document.getElementById('ek-root').style.display = 'flex';
        document.getElementById('ek-fab').style.display = 'none';

        if (token !== lastLoadedToken || coursesCache.length === 0) {
            if (token !== lastLoadedToken) {
                coursesCache = [];
                tasksCache = [];
                loadedCourseKey = '';
                activeCourse = null;
                courseSearchQuery = '';
            }
            switchView('courses');
            loadCourses(true);
        }
    }

    function closeMobileOverlay() {
        isOverlayOpen = false;
        document.getElementById('ek-root').style.display = 'none';
        setMobileViewport(false);
        syncLoginVisibility();
    }

    // ====== 9. 第一级：自动拉取账号全部课程 ======
    function mergeCourseItem(map, incoming) {
        if (!incoming || !incoming.courseId) return;
        const id = String(incoming.courseId);
        const prev = map.get(id);
        if (!prev) {
            map.set(id, { ...incoming, courseId: id });
            return;
        }
        map.set(id, {
            courseId: id,
            courseName: incoming.courseName || prev.courseName,
            planId: incoming.planId || prev.planId,
            classId: (incoming.classId && incoming.classId !== '0') ? incoming.classId : prev.classId,
            semesterId: incoming.semesterId || prev.semesterId,
            semesterLabel: incoming.semesterLabel || prev.semesterLabel,
            isCurrent: Boolean(prev.isCurrent || incoming.isCurrent),
            teachers: (incoming.teachers && incoming.teachers.length >= (prev.teachers || '').length)
                ? incoming.teachers
                : prev.teachers,
            hours: incoming.hours || prev.hours,
            recentTime: incoming.recentTime || prev.recentTime
        });
    }

    async function fetchAllCourses(token) {
        const encoded = encodeURIComponent(token);
        const urlGrouped = `https://cloud-api.easyketang.com/resource/admin/course/get_teacher_course_list?token=${encoded}&type=2`;
        const urlAll = `https://cloud-api.easyketang.com/admin/course/get_new_course_list?is_all=1&keyword=&token=${encoded}`;

        const [resGrouped, resAll] = await Promise.allSettled([
            rawFetch(urlGrouped).then(r => r.json()),
            rawFetch(urlAll).then(r => r.json())
        ]);

        const merged = new Map();
        let anySuccess = false;
        let authErrorMsg = '';

        if (resGrouped.status === 'fulfilled' && resGrouped.value) {
            const json = resGrouped.value;
            if (json.status === 1 && json.data && Array.isArray(json.data.list)) {
                anySuccess = true;
                json.data.list.forEach(sem => {
                    const semLabel = `${sem.semester || ''} ${sem.semester_name || ''}`.trim();
                    const list = Array.isArray(sem.course_list) ? sem.course_list : [];
                    list.forEach(c => {
                        const cSemLabel = `${c.semester || sem.semester || ''} ${c.semester_name || sem.semester_name || ''}`.trim() || semLabel;
                        const teachers = Array.isArray(c.teacher_list) && c.teacher_list.length
                            ? c.teacher_list.join(' / ')
                            : (c.course_created_name || '');
                        const classId = c.class_id || (Array.isArray(c.class_list) && c.class_list[0] && c.class_list[0].id) || '0';
                        mergeCourseItem(merged, {
                            courseId: String(c.course_id),
                            courseName: (c.course_name || `课程 #${c.course_id}`).trim(),
                            planId: String(c.plan_id || ''),
                            classId: String(classId),
                            semesterId: Number(c.semester_id || sem.semester_id || 0),
                            semesterLabel: cSemLabel,
                            isCurrent: Number(sem.is_current) === 1,
                            teachers,
                            hours: Number(c.total_hours || c.course_hours || 0),
                            recentTime: ''
                        });
                    });
                });
            } else if (json.message && /登录|token|过期|失效|无权/i.test(json.message)) {
                authErrorMsg = json.message;
            }
        }

        if (resAll.status === 'fulfilled' && resAll.value) {
            const json = resAll.value;
            if (json.status === 1 && Array.isArray(json.data)) {
                anySuccess = true;
                json.data.forEach(c => {
                    const semLabel = `${c.xq_name || ''} ${c.xq_index || c.xq || ''}`.trim();
                    const teachers = Array.isArray(c.teacher_name) && c.teacher_name.length
                        ? c.teacher_name.join(' / ')
                        : (c.create_name || '');
                    const classId = c.class_id || (Array.isArray(c.class_info) && c.class_info[0] && c.class_info[0].id) || '0';
                    mergeCourseItem(merged, {
                        courseId: String(c.id),
                        courseName: (c.name || `课程 #${c.id}`).trim(),
                        planId: String(c.plan_id || ''),
                        classId: String(classId),
                        semesterId: Number(c.semester_id || 0),
                        semesterLabel: semLabel,
                        isCurrent: false,
                        teachers,
                        hours: 0,
                        recentTime: c.recent_time || ''
                    });
                });
            } else if (!authErrorMsg && json.message && /登录|token|过期|失效|无权/i.test(json.message)) {
                authErrorMsg = json.message;
            }
        }

        Object.values(passiveCourses).forEach(c => {
            if (!merged.has(c.courseId)) mergeCourseItem(merged, c);
        });

        if (!anySuccess && merged.size === 0) {
            if (authErrorMsg) resetAuthSession();
            throw new Error(authErrorMsg || '未能拉取到课程列表，请检查登录状态');
        }

        return Array.from(merged.values());
    }

    function renderLoginPrompt(container, errMsg) {
        container.innerHTML = `
      <div class="ek-card">
        <div style="font-size:17px;font-weight:700;">👋 登录状态已失效</div>
        <div style="font-size:13px;color:#6e6e73;margin-top:8px;line-height:1.6;">
          ${errMsg ? `<span style="color:#ff3b30;">${escapeHtml(errMsg)}</span><br/>` : ''}
          请回到原网页重新登录，登录后极简模式按钮会自动出现。
        </div>
        <button class="ek-primary-btn" id="ek-go-login">回到原网页</button>
      </div>
    `;
        document.getElementById('ek-go-login').addEventListener('click', closeMobileOverlay);
    }

    async function loadCourses(forceReload = false) {
        const container = document.getElementById('ek-view-courses');
        const token = getToken();

        if (!token) {
            lastLoadedToken = '';
            coursesCache = [];
            renderLoginPrompt(container, '');
            return;
        }

        if (!forceReload && token === lastLoadedToken && coursesCache.length > 0) {
            renderCourseList();
            return;
        }

        container.innerHTML = `<div class="ek-card" style="text-align:center;color:#8e8e93;">正在获取你的全部课程...</div>`;

        try {
            const list = await fetchAllCourses(token);
            coursesCache = list;
            lastLoadedToken = token;
            renderCourseList();
        } catch (err) {
            lastLoadedToken = '';
            renderLoginPrompt(container, err.message);
        }
    }

    function renderCourseList() {
        const container = document.getElementById('ek-view-courses');
        if (coursesCache.length === 0) {
            container.innerHTML = `
        <div class="ek-card" style="text-align:center;color:#8e8e93;">
          当前账号下暂未查询到课程。<br/>
          <button class="ek-mini-btn" id="ek-empty-reload" style="margin-top:12px;">重新加载</button>
        </div>
      `;
            document.getElementById('ek-empty-reload').addEventListener('click', () => loadCourses(true));
            return;
        }

        const q = courseSearchQuery.trim().toLowerCase();
        const filtered = q
            ? coursesCache.filter(c =>
                c.courseName.toLowerCase().includes(q) ||
                (c.teachers || '').toLowerCase().includes(q) ||
                (c.semesterLabel || '').toLowerCase().includes(q)
            )
            : coursesCache;

        const groupMap = new Map();
        filtered.forEach(c => {
            const key = c.semesterLabel || '其他课程';
            if (!groupMap.has(key)) {
                groupMap.set(key, {
                    label: key,
                    isCurrent: c.isCurrent,
                    semesterId: c.semesterId || 0,
                    items: []
                });
            }
            const g = groupMap.get(key);
            if (c.isCurrent) g.isCurrent = true;
            if ((c.semesterId || 0) > g.semesterId) g.semesterId = c.semesterId;
            g.items.push(c);
        });

        const groups = Array.from(groupMap.values()).sort((a, b) => {
            if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
            return b.semesterId - a.semesterId;
        });

        const lastCourseId = localStorage.getItem(STORAGE_KEYS.lastCourse) || '';
        const showSearch = coursesCache.length > 4 || courseSearchQuery.length > 0;

        let html = '';
        if (showSearch) {
            html += `
        <div class="ek-search-wrap">
          <input id="ek-course-search" class="ek-search-input" type="search" placeholder="搜索课程名、教师或学期..." value="${escapeHtml(courseSearchQuery)}" />
        </div>
      `;
        }

        if (groups.length === 0) {
            html += `<div class="ek-card" style="text-align:center;color:#8e8e93;">没有匹配「${escapeHtml(courseSearchQuery)}」的课程</div>`;
        } else {
            groups.forEach(g => {
                html += `
          <div class="ek-section-title">
            <span>${escapeHtml(g.label)}</span>
            ${g.isCurrent ? '<span class="ek-sem-curr">当前学期</span>' : ''}
          </div>
        `;
                g.items.forEach(c => {
                    const isLast = c.courseId === lastCourseId;
                    const metaParts = [];
                    if (c.teachers) metaParts.push(`教师：${c.teachers}`);
                    if (c.hours > 0) metaParts.push(`${c.hours} 学时`);
                    html += `
            <div class="ek-card ek-course-card" data-cid="${escapeHtml(c.courseId)}">
              <div style="min-width:0;flex:1;">
                <div class="ek-course-name">
                  <span>${escapeHtml(c.courseName)}</span>
                  ${isLast ? '<span class="ek-tag ek-last-tag">上次学习</span>' : ''}
                </div>
                <div class="ek-course-sub">${escapeHtml(metaParts.join(' · ') || `课程 ID：${c.courseId}`)}</div>
              </div>
              <div style="color:#c7c7cc;font-size:20px;margin-left:10px;">›</div>
            </div>
          `;
                });
            });
        }

        container.innerHTML = html;

        const searchInput = document.getElementById('ek-course-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                courseSearchQuery = e.target.value;
                const pos = searchInput.selectionStart;
                renderCourseList();
                const nextInput = document.getElementById('ek-course-search');
                if (nextInput) {
                    nextInput.focus();
                    try { nextInput.setSelectionRange(pos, pos); } catch (err) { }
                }
            });
        }

        container.querySelectorAll('.ek-course-card').forEach(card => {
            card.addEventListener('click', () => {
                const cid = card.dataset.cid;
                const found = coursesCache.find(x => x.courseId === cid);
                if (!found) return;
                activeCourse = found;
                localStorage.setItem(STORAGE_KEYS.lastCourse, found.courseId);
                container.querySelectorAll('.ek-last-tag').forEach(t => t.remove());
                const nameEl = card.querySelector('.ek-course-name');
                if (nameEl) {
                    const tag = document.createElement('span');
                    tag.className = 'ek-tag ek-last-tag';
                    tag.textContent = '上次学习';
                    nameEl.appendChild(tag);
                }
                switchView('tasks', found.courseName);
                loadTasks(false);
            });
        });
    }

    // ====== 10. 第二级：拉取章节/实验目录 ======
    async function loadTasks(forceReload = false) {
        const container = document.getElementById('ek-view-tasks');
        const token = getToken();
        const course = activeCourse;

        if (!token || !course) {
            switchView('courses');
            loadCourses(true);
            return;
        }

        const courseKey = `${course.courseId}_${course.planId}`;
        if (!forceReload && loadedCourseKey === courseKey && tasksCache.length > 0) {
            return;
        }

        const reqId = ++activeTaskReqId;
        container.scrollTop = 0;
        container.innerHTML = `<div class="ek-card" style="text-align:center;color:#8e8e93;">正在拉取「${escapeHtml(course.courseName)}」目录...</div>`;

        try {
            const qs = new URLSearchParams({
                course_id: course.courseId,
                token: token
            });
            if (course.planId) qs.set('plan_id', course.planId);

            const url = `https://cloud-api.easyketang.com/admin/task_lite/new_query?${qs.toString()}`;
            const res = await rawFetch(url);
            const json = await res.json();

            if (reqId !== activeTaskReqId) return;

            if (json.status !== 1 || !Array.isArray(json.data)) {
                const msg = json.message || '接口返回异常';
                if (/登录|token|过期|失效|无权/i.test(msg)) resetAuthSession();
                throw new Error(msg);
            }

            tasksCache = json.data;
            loadedCourseKey = courseKey;

            if (tasksCache.length === 0) {
                container.innerHTML = `
          <div class="ek-card" style="text-align:center;color:#8e8e93;">
            该课程暂未发布实验或章节内容。
          </div>
        `;
                return;
            }

            const toolbarHtml = `
        <div class="ek-toolbar">
          <span>共 ${tasksCache.length} 项内容</span>
          <button class="ek-mini-btn" id="ek-refresh-tasks">🔄 刷新目录</button>
        </div>
      `;

            const listHtml = tasksCache.map(t => {
                const pct = Number(t.process) || 0;
                const hoursText = t.total_hours ? `学时：${escapeHtml(t.total_hours)} 小时` : '点击查看资源';
                return `
          <div class="ek-card ek-task-item" data-task-id="${escapeHtml(t.id)}" data-task-name="${escapeHtml(t.name)}">
            <div style="min-width:0;flex:1;">
              <div style="font-size:16px;font-weight:600;">${escapeHtml(t.name)}</div>
              <div style="font-size:12px;color:#8e8e93;margin-top:4px;">${hoursText}</div>
            </div>
            <span class="ek-badge ${pct >= 100 ? 'done' : ''}">${pct}%</span>
          </div>
        `;
            }).join('');

            container.innerHTML = toolbarHtml + listHtml;

            document.getElementById('ek-refresh-tasks').addEventListener('click', () => {
                loadTasks(true);
                showToast('正在刷新目录...');
            });

            container.querySelectorAll('.ek-task-item').forEach(el => {
                el.addEventListener('click', () => loadTaskDetail(el.dataset.taskId, el.dataset.taskName));
            });
        } catch (err) {
            if (reqId !== activeTaskReqId) return;
            loadedCourseKey = '';
            container.innerHTML = `
        <div class="ek-card">
          <div style="color:#ff3b30;font-weight:600;">目录拉取失败：${escapeHtml(err.message)}</div>
          <div style="display:flex;gap:10px;margin-top:12px;">
            <button id="ek-reload-tasks" class="ek-mini-btn" style="background:#007aff;color:#fff;padding:8px 14px;">重试</button>
            <button id="ek-back-courses" class="ek-mini-btn" style="padding:8px 14px;">返回课程列表</button>
          </div>
        </div>
      `;
            document.getElementById('ek-reload-tasks').addEventListener('click', () => loadTasks(true));
            document.getElementById('ek-back-courses').addEventListener('click', () => switchView('courses'));
        }
    }

    // ====== 11. 第三级：拉取单章/实验内资源 ======
    function normalizeTaskSections(taskItem) {
        const sections = [];
        const collect = (raw, fallbackName) => {
            if (!Array.isArray(raw) || raw.length === 0) return;
            const looksLikeStages = raw.some(x => x && Array.isArray(x.resource));
            if (looksLikeStages) {
                raw.forEach(stage => {
                    const list = Array.isArray(stage && stage.resource) ? stage.resource : [];
                    if (list.length > 0) {
                        sections.push({
                            name: stage.name || fallbackName,
                            process: stage.process,
                            resources: list
                        });
                    }
                });
            } else {
                sections.push({
                    name: fallbackName,
                    process: null,
                    resources: raw
                });
            }
        };

        collect(taskItem.experiment, '实验内容');
        collect(taskItem.no_experiment, '课程资源');
        return sections;
    }

    async function fetchTaskItemJson(courseId, taskId, classId, token) {
        const qs = new URLSearchParams({
            course_id: courseId,
            task_id: taskId,
            class_id: classId,
            token: token
        });
        const url = `https://cloud-api.easyketang.com/admin/task_item/get_nnew_list_item?${qs.toString()}`;
        const res = await rawFetch(url);
        return res.json();
    }

    async function loadTaskDetail(taskId, taskName) {
        const reqId = ++activeDetailReqId;
        switchView('detail', taskName);
        const detailEl = document.getElementById('ek-view-detail');
        detailEl.scrollTop = 0;
        detailEl.innerHTML = `<div class="ek-card" style="text-align:center;color:#8e8e93;">正在加载「${escapeHtml(taskName)}」...</div>`;

        try {
            const token = getToken();
            const course = activeCourse;
            if (!token || !course) throw new Error('登录状态或课程信息缺失');

            const preferredClassId = course.classId || '0';
            let json = await fetchTaskItemJson(course.courseId, taskId, preferredClassId, token);

            let sections = (json && json.status === 1 && json.data && json.data.task_item)
                ? normalizeTaskSections(json.data.task_item)
                : [];
            if (sections.length === 0 && preferredClassId !== '0') {
                const fallbackJson = await fetchTaskItemJson(course.courseId, taskId, '0', token);
                if (fallbackJson && fallbackJson.status === 1 && fallbackJson.data && fallbackJson.data.task_item) {
                    json = fallbackJson;
                    sections = normalizeTaskSections(json.data.task_item);
                }
            }

            if (reqId !== activeDetailReqId) return;

            if (!json || json.status !== 1 || !json.data || !json.data.task_item) {
                throw new Error((json && json.message) || '资源数据为空');
            }

            const lastPlayedId = localStorage.getItem(STORAGE_KEYS.lastPlayed) || '';
            currentVideos = [];

            let html = '';
            sections.forEach(section => {
                const procLabel = section.process !== null && section.process !== undefined
                    ? `（进度 ${Number(section.process) || 0}%）`
                    : '';
                html += `<div class="ek-section-title">${escapeHtml(section.name)}${procLabel}</div>`;
                html += `<div class="ek-res-list">`;

                section.resources.forEach(item => {
                    if (!item || typeof item !== 'object') return;
                    const cleanName = (item.filename || item.name || '未命名资源').trim();
                    const vid = String(item.video_id || '').trim();
                    const contentStr = typeof item.content === 'string' ? item.content.trim() : '';

                    const isVideo = Number(item.category_id) === 6 || vid.length > 10;
                    const isHttpDoc = !isVideo && /^https?:\/\//i.test(contentStr);
                    const isPdf = isHttpDoc && (Number(item.category_id) === 13 || /\.pdf(\?|$)/i.test(contentStr) || /\.pdf$/i.test(cleanName));

                    let videoIndexAttr = '';
                    let resumeTagHtml = '';
                    if (isVideo) {
                        const idx = currentVideos.length;
                        currentVideos.push({
                            resourceId: String(item.id),
                            videoId: vid || contentStr,
                            title: cleanName,
                            duration: Number(item.times) || 0
                        });
                        videoIndexAttr = `data-video-index="${idx}"`;
                        const savedProg = getVideoProgress(item.id);
                        if (savedProg && savedProg.time >= 5) {
                            resumeTagHtml = `<span class="ek-tag ek-resume-tag">看到 ${formatDuration(savedProg.time)}</span>`;
                        }
                    }

                    const icon = isVideo ? '🎬' : (isPdf ? '📄' : (isHttpDoc ? '📎' : '📝'));
                    const isLast = isVideo && String(item.id) === lastPlayedId;
                    const itemPct = Number(item.process) || 0;
                    const metaText = isVideo
                        ? `${formatDuration(item.times) || '视频'} · 平台进度 ${itemPct}%`
                        : (isPdf ? 'PDF 讲义 · 点击预览/保存' : (isHttpDoc ? '文档/链接 · 点击打开' : '考核/报告 · 需在原网页完成'));

                    html += `
            <div class="ek-res-item"
                 data-type="${isVideo ? 'video' : (isHttpDoc ? 'doc' : 'other')}"
                 data-res-id="${escapeHtml(item.id)}"
                 data-url="${escapeHtml(isHttpDoc ? contentStr : '')}"
                 ${videoIndexAttr}>
              <div class="ek-res-icon">${icon}</div>
              <div class="ek-res-info">
                <div class="ek-res-name">${escapeHtml(cleanName)}</div>
                <div class="ek-res-meta">
                  <span>${metaText}</span>
                  ${resumeTagHtml}
                  ${isLast ? '<span class="ek-tag ek-last-tag">上次观看</span>' : ''}
                </div>
              </div>
              <div style="color:#c7c7cc;font-size:18px;margin-left:8px;">›</div>
            </div>
          `;
                });

                html += `</div>`;
            });

            detailEl.innerHTML = html || `<div class="ek-card" style="text-align:center;color:#8e8e93;">该章节暂无可展示资源</div>`;

            detailEl.querySelectorAll('.ek-res-item').forEach(el => {
                el.addEventListener('click', () => {
                    const type = el.dataset.type;
                    if (type === 'video') {
                        playVideoByIndex(Number(el.dataset.videoIndex));
                    } else if (type === 'doc' && el.dataset.url) {
                        window.open(el.dataset.url, '_blank', 'noopener,noreferrer');
                    } else {
                        showToast('考核与作业报告请点右上角「原网页」提交');
                    }
                });
            });
        } catch (err) {
            if (reqId !== activeDetailReqId) return;
            detailEl.innerHTML = `<div class="ek-card" style="color:#ff3b30;">加载失败：${escapeHtml(err.message)}</div>`;
        }
    }

    // ====== 12A. 本地视频下载（独立下载调度；Mediabunny 1.66.0 MPL-2.0） ======
    // 仅用于有权离线保存的资源；不处理 DRM、私有加密或访问控制绕过。
    function dlStatus(msg, percent = 0) {
        const label = dlEl('ek-dl-status'), bar = dlEl('ek-dl-progress');
        if (label) label.textContent = msg;
        if (bar) bar.value = Math.max(0, Math.min(100, percent));
    }
    function dlResetCloseConfirm() {
        clearTimeout(dlCloseConfirmTimer);
        dlCloseConfirmTimer = null;
        dlCloseConfirmPending = false;
        const btn = dlEl('ek-player-close');
        if (btn) btn.textContent = '关闭';
    }
    function dlButtons() {
        if (!dlEl('ek-dl-start')) return;
        dlEl('ek-dl-start').disabled = !dlSource || !!dlJob;
        dlEl('ek-dl-cancel').hidden = !dlJob;
        dlEl('ek-dl-save').hidden = !dlFile;
        dlEl('ek-dl-preview').hidden = !dlFile;
        dlEl('ek-dl-share').hidden = !dlFile || typeof navigator.share !== 'function';
        updateNavButtons();
    }
    function dlClearPreview() {
        const v = dlEl('ek-dl-preview-video');
        if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { } v.style.display = 'none'; }
        if (dlPreviewUrl) { URL.revokeObjectURL(dlPreviewUrl); dlPreviewUrl = ''; }
        const b = dlEl('ek-dl-preview'); if (b) b.textContent = '预览生成的 MP4（保存前检查）';
    }
    function dlPreview() {
        if (!dlFile || !dlSource || getToken() !== dlSource.token) return;
        if (dlPreviewUrl) { dlClearPreview(); return; }
        const v = dlEl('ek-dl-preview-video');
        dlEl('ek-video')?.pause();
        dlPreviewUrl = URL.createObjectURL(dlFile); v.src = dlPreviewUrl; v.style.display = 'block';
        dlEl('ek-dl-preview').textContent = '关闭文件预览';
        v.play().catch(() => showToast('请点击预览视频的播放键'));
    }
    function dlReset() {
        dlResetCloseConfirm();
        dlClearPreview();
        if (dlJob) dlJob.controller.abort();
        dlJob = null; dlSource = null; dlFile = null;
        if (dlObjectUrl) { URL.revokeObjectURL(dlObjectUrl); dlObjectUrl = ''; }
        dlStatus('视频地址就绪后可下载'); dlButtons();
    }
    function dlCheck(job) {
        if (job !== dlJob || job.controller.signal.aborted || capturedToken !== job.token || isOnPublicOrAuthPage()) {
            throw new DOMException('下载已取消', 'AbortError');
        }
    }
    function dlUrl(uri, base) {
        const u = new URL(uri, base);
        if (u.protocol !== 'https:' || u.username || u.password) dlFail('不支持非 HTTPS 媒体地址');
        return u.href;
    }
    async function dlRead(url, job, limit, retries = 2) {
        for (let attempt = 0; ; attempt++) {
            dlCheck(job);
            try {
                const r = await rawFetch(url, { signal: job.controller.signal, credentials: 'same-origin', cache: 'no-store' });
                if (!r.ok) {
                    const err = new Error(`媒体请求失败 HTTP ${r.status}`);
                    err.noRetry = r.status >= 400 && r.status < 500 && r.status !== 429;
                    throw err;
                }
                const n = Number(r.headers.get('content-length'));
                if (n > limit) { const err = new Error('媒体超出移动端内存限制'); err.noRetry = true; throw err; }
                let bytes;
                if (r.body && r.body.getReader) {
                    const reader = r.body.getReader(); const chunks = []; let total = 0;
                    try {
                        while (true) {
                            dlCheck(job);
                            const { done, value } = await reader.read();
                            if (done) break;
                            total += value.byteLength;
                            if (total > limit) { const err = new Error('媒体超出移动端内存限制'); err.noRetry = true; throw err; }
                            chunks.push(value);
                        }
                        bytes = new Uint8Array(total); let pos = 0;
                        for (const c of chunks) { bytes.set(c, pos); pos += c.length; }
                    } catch (e) { reader.cancel().catch(() => { }); throw e; }
                    finally { reader.releaseLock(); }
                } else {
                    bytes = new Uint8Array(await r.arrayBuffer());
                    if (bytes.length > limit) dlFail('媒体超出移动端内存限制');
                }
                dlCheck(job);
                if (!bytes.length) dlFail('媒体响应为空');
                return { bytes, url: dlUrl(r.url || url, url) };
            } catch (e) {
                dlCheck(job);
                if (e.noRetry || attempt >= retries) {
                    if (e instanceof TypeError) dlFail('无法读取媒体（网络或 CORS 限制）；在线播放不代表允许下载');
                    throw e;
                }
                await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
            }
        }
    }
    function dlAttrs(line) {
        const attrs = Object.create(null);
        const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g;
        let m; while ((m = re.exec(line))) attrs[m[1]] = m[2] ?? m[3];
        return attrs;
    }
    function dlParse(text, base) {
        const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (lines[0] !== '#EXTM3U') dlFail('不是有效的 M3U8 播放列表');
        const variants = [], segments = [];
        let stream = null, seconds = null, key = null, seq = 0, end = false;
        let separateAudio = new Set(), unsupported = '';
        for (const line of lines.slice(1)) {
            if (line.startsWith('#EXT-X-MEDIA:')) {
                const a = dlAttrs(line.slice(13));
                if (a.TYPE === 'AUDIO' && a.URI) separateAudio.add(a['GROUP-ID']);
            } else if (line.startsWith('#EXT-X-STREAM-INF:')) stream = dlAttrs(line.slice(18));
            else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                seq = Number(line.slice(22));
                if (!Number.isSafeInteger(seq) || seq < 0) dlFail('HLS 序列号异常');
            } else if (line.startsWith('#EXTINF:')) {
                seconds = Number(line.slice(8).split(',')[0]);
                if (!Number.isFinite(seconds) || seconds <= 0) dlFail('HLS 分片时长异常');
            } else if (line.startsWith('#EXT-X-KEY:')) {
                const a = dlAttrs(line.slice(11));
                if (a.METHOD === 'NONE') key = null;
                else if (a.METHOD === 'AES-128' && (!a.KEYFORMAT || a.KEYFORMAT === 'identity') && a.URI) {
                    key = { url: dlUrl(a.URI, base), iv: a.IV || '' };
                } else dlFail('不支持该加密类型（DRM/私有加密/SAMPLE-AES）');
            } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
                const a = dlAttrs(line.slice(19));
                if (a.METHOD !== 'AES-128' || (a.KEYFORMAT && a.KEYFORMAT !== 'identity')) dlFail('不支持该会话加密类型');
            } else if (line === '#EXT-X-ENDLIST') end = true;
            else if (/^#EXT-X-(MAP|BYTERANGE|DISCONTINUITY|GAP|PART|SKIP|DEFINE)(:|$)/.test(line)) unsupported = line.split(':')[0];
            else if (!line.startsWith('#')) {
                if (stream) { variants.push({ url: dlUrl(line, base), attrs: stream }); stream = null; }
                else if (seconds !== null) {
                    segments.push({ url: dlUrl(line, base), duration: seconds, key, seq: seq + segments.length }); seconds = null;
                } else dlFail('播放列表存在未知媒体条目');
            }
        }
        if (variants.length) {
            if (segments.length || stream) dlFail('主播放列表结构异常');
            const compatible = variants.filter(v => !separateAudio.has(v.attrs.AUDIO) && (!v.attrs.CODECS || /avc[13]/i.test(v.attrs.CODECS)));
            if (!compatible.length) dlFail('暂不支持独立音轨或非 H.264 视频');
            // 优先中等清晰度，减少 iOS 内存占用。
            compatible.sort((a, b) => Number(a.attrs.BANDWIDTH || 0) - Number(b.attrs.BANDWIDTH || 0));
            const selected = compatible.filter(v => Number(v.attrs.BANDWIDTH) <= 2500000).pop() || compatible[0];
            return { variant: selected.url };
        }
        if (unsupported) dlFail(`暂不支持此 HLS 结构：${unsupported}`);
        if (!end || !segments.length || seconds !== null) dlFail('只支持完整的点播播放列表');
        if (segments.length > 3000) dlFail('分片数量过多');
        return { segments, duration: segments.reduce((s, p) => s + p.duration, 0) };
    }
    function dlIV(hex, seq) {
        let value;
        if (hex) {
            if (!/^0x[0-9a-f]{1,32}$/i.test(hex)) dlFail('HLS IV 格式异常');
            value = BigInt(hex);
        } else value = BigInt(seq);
        const iv = new Uint8Array(16);
        for (let i = 15; i >= 0; i--) { iv[i] = Number(value & 255n); value >>= 8n; }
        return iv;
    }
    async function dlSegment(segment, job, keys) {
        let { bytes } = await dlRead(segment.url, job, DL_PART_LIMIT);
        if (segment.key) {
            if (!window.crypto?.subtle) dlFail('当前环境不支持标准 HLS 解密');
            const k = segment.key;
            const keyCacheId = k.url;
            // 仅使用播放列表公开指定且当前会话能够正常读取的标准 16 字节密钥，按 URL 缓存并允许常规网络重试。
            if (!keys.has(keyCacheId)) keys.set(keyCacheId, (async () => {
                const { bytes: raw } = await dlRead(k.url, job, 16, 2);
                if (raw.length !== 16) dlFail('不是标准 AES-128 HLS 密钥');
                return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
            })());
            const cryptoKey = await keys.get(keyCacheId);
            try { bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: dlIV(k.iv, segment.seq) }, cryptoKey, bytes)); }
            catch (e) { dlFail('标准 HLS 解密失败；不支持平台私有加密'); }
        }
        dlCheck(job);
        if (bytes.length < 376 || bytes.length % 188 !== 0 || bytes[0] !== 0x47 || bytes[188] !== 0x47) dlFail('分片不是有效的 MPEG-TS，已停止，未生成损坏文件');
        return bytes;
    }
    // MP4 box 解析：按真实长度遍历，而非搜索字节串或假定所有字段为同一时基。
    function dlBoxes(bytes, start = 0, end = bytes.length) {
        const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
        for (let p = start; p < end;) {
            if (end - p < 8) dlFail('MP4 box 头不完整');
            let size = d.getUint32(p), head = 8;
            const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
            if (size === 1) { if (end - p < 16) dlFail('MP4 大 box 头不完整'); size = Number(d.getBigUint64(p + 8)); head = 16; }
            else if (size === 0) size = end - p;
            if (!Number.isSafeInteger(size) || size < head || p + size > end) dlFail('MP4 box 长度异常');
            out.push({ type, p, data: p + head, end: p + size }); p += size;
        }
        return out;
    }
    // Download dependency is deliberately isolated from document-start initialization.
    // The pinned standalone bundle is fetched only for an HLS download, without credentials or Referer.
    let dlMediaLibPromise = null;
    async function dlMediaLib() {
        if (!dlMediaLibPromise) {
            const load = async () => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 20000);
                let blobUrl = '';
                try {
                    const res = await rawFetch(DL_MEDIA_LIB_URL, {
                        signal: controller.signal,
                        credentials: 'omit',
                        referrerPolicy: 'no-referrer'
                    });
                    if (!res.ok) throw new Error(`媒体库拉取失败 HTTP ${res.status}`);
                    const buf = await res.arrayBuffer();
                    const expectedHash = DL_MEDIA_LIB_SHA256.trim().toLowerCase();
                    if (expectedHash) {
                        if (!window.crypto?.subtle) throw new Error('当前环境不支持完整性校验');
                        const digest = await crypto.subtle.digest('SHA-256', buf);
                        const actualHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
                        if (actualHash !== expectedHash) throw new Error('媒体库完整性校验失败');
                    }
                    blobUrl = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }));
                    const lib = await import(blobUrl);
                    if (!lib?.MPEG_TS || !lib?.MP4 || !lib?.Conversion || !lib?.BlobSource || !lib?.Mp4OutputFormat) {
                        throw new Error('媒体库接口不兼容');
                    }
                    return lib;
                } finally {
                    clearTimeout(timer);
                    if (blobUrl) URL.revokeObjectURL(blobUrl);
                }
            };
            dlMediaLibPromise = load().catch((err) => {
                dlMediaLibPromise = null;
                if (err && err.message === '媒体库完整性校验失败') {
                    dlFail('媒体库完整性校验失败，已中止加载。');
                }
                dlFail('媒体库加载失败（网络、Safari 或网页安全策略限制）。极简模式和在线播放仍可使用，请检查网络后重试下载。');
            });
        }
        return dlMediaLibPromise;
    }
    function dlDurationText(n) { return Number.isFinite(n) ? `${n.toFixed(2)}秒` : String(n); }
    function dlDurationCheck(actual, expected, label) {
        if (!Number.isFinite(actual) || actual <= 0 || (expected > 0 && Math.abs(actual - expected) > Math.max(3, expected * 0.02))) {
            dlFail(`${label}：实际 ${dlDurationText(actual)}，预期 ${dlDurationText(expected)}`);
        }
    }
    async function dlCheckOutput(lib, blob, expected, hasAudio, job) {
        const input = new lib.Input({ formats: [lib.MP4], source: new lib.BlobSource(blob) });
        const abort = () => input.dispose();
        job.controller.signal.addEventListener('abort', abort, { once: true });
        try {
            const [v, a] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
            if (!v) dlFail('输出 MP4 缺少视频轨');
            if (hasAudio && !a) dlFail('输出 MP4 缺少音频轨');
            const [vc, vs, ve] = await Promise.all([v.getCodec(), v.getFirstTimestampOrNull(), v.computeDurationOrNull()]);
            dlCheck(job);
            if (vc !== 'avc') dlFail(`输出视频编码不受本版支持：${vc || '未知'}`);
            if ([vs, ve].some(x => x === null || !Number.isFinite(x))) dlFail('输出视频轨道没有有效采样');
            dlDurationCheck(ve - vs, expected, '视频轨实际时长异常');
            if (a) {
                const [ac, as, ae] = await Promise.all([a.getCodec(), a.getFirstTimestampOrNull(), a.computeDurationOrNull()]);
                dlCheck(job);
                if (ac !== 'aac') dlFail(`输出音频编码不受本版支持：${ac || '未知'}`);
                if ([as, ae].some(x => x === null || !Number.isFinite(x))) dlFail('输出音频轨道没有有效采样');
                dlDurationCheck(ae - as, expected, '音轨实际时长异常');
                if (Math.abs(ve - ae) > 3 || Math.abs(vs - as) > 3) dlFail(`音视频时间轴不一致：视频 ${dlDurationText(ve)} / 音频 ${dlDurationText(ae)}`);
            }
            const total = await input.computeDuration(); dlCheck(job);
            dlDurationCheck(total, expected, 'MP4 实际时长异常'); return total;
        } finally { job.controller.signal.removeEventListener('abort', abort); input.dispose(); }
    }
    async function dlRemux(tsHolder, expected, job) {
        const lib = await dlMediaLib();
        dlCheck(job);
        let blob = null;
        let hasAudio = false;
        // 独立作用域：封装结束后立即释放 TS Blob 与 BufferTarget，再执行输出校验以压低 iOS 内存峰值。
        {
            const input = new lib.Input({ formats: [lib.MPEG_TS], source: new lib.BlobSource(tsHolder.ts) });
            let target = new lib.BufferTarget();
            // fastStart:false: ordinary, non-fragmented MP4 with metadata at the end; no re-encoding.
            const output = new lib.Output({ format: new lib.Mp4OutputFormat({ fastStart: false }), target });
            let conversion = null, oversize = false;
            const abort = () => { if (conversion) Promise.resolve(conversion.cancel()).catch(() => { }); input.dispose(); };
            job.controller.signal.addEventListener('abort', abort, { once: true });
            try {
                dlCheck(job);
                const [v, a] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
                if (!v) dlFail('原始 TS 缺少可识别的视频轨');
                const vc = await v.getCodec();
                if (vc !== 'avc') dlFail(`原始视频编码暂不支持：${vc || '未知'}（需要 H.264）`);
                if (a) {
                    const ac = await a.getCodec();
                    if (ac !== 'aac') dlFail(`原始音频编码暂不支持：${ac || '未知'}（需要 AAC）`);
                    hasAudio = true;
                }
                dlCheck(job);
                dlStatus('正在重建普通 MP4 音视频索引...', 84);
                conversion = await lib.Conversion.init({ input, output, tracks: 'primary', copy: { mode: 'forced', shiftTolerance: Infinity }, tags: {}, showWarnings: false });
                dlCheck(job);
                const badDiscard = conversion.discardedTracks.some(x => x.track === v || (a && x.track === a));
                const missingTrack = !conversion.utilizedTracks.includes(v) || (a && !conversion.utilizedTracks.includes(a));
                if (!conversion.isValid || badDiscard || missingTrack) dlFail('无法无损保留完整音视频轨道');
                target.onwrite = (_start, end) => { if (end > DL_LIMIT && !oversize) { oversize = true; Promise.resolve(conversion.cancel()).catch(() => { }); } };
                conversion.onProgress = progress => { if (job === dlJob && !job.controller.signal.aborted) dlStatus(`正在生成普通 MP4 · ${Math.round(progress * 100)}%`, 84 + Math.max(0, Math.min(1, progress)) * 12); };
                try { await conversion.execute(); } catch (e) { if (oversize) dlFail('输出 MP4 超过 512 MiB'); throw e; }
                dlCheck(job);
                if (oversize || !target.buffer || target.buffer.byteLength > DL_LIMIT) dlFail('输出 MP4 为空或超过 512 MiB');
                blob = new Blob([target.buffer], { type: 'video/mp4' });
                try { target.buffer = null; } catch (e) { }
                target = null;
                conversion = null;
            } finally {
                job.controller.signal.removeEventListener('abort', abort);
                input.dispose();
                tsHolder.ts = null;
            }
        }
        dlCheck(job);
        dlStatus('正在验证普通 MP4 音视频轨道...', 97);
        const duration = await dlCheckOutput(lib, blob, expected, hasAudio, job);
        return { blob, duration };
    }
    async function dlHls(first, job, expected, strictDuration) {
        dlStatus('正在加载媒体处理库...');
        await dlMediaLib();
        dlCheck(job);
        let current = first, playlist;
        for (let depth = 0; depth < 4; depth++) {
            playlist = dlParse(new TextDecoder().decode(current.bytes), current.url);
            if (!playlist.variant) break;
            current = await dlRead(playlist.variant, job, 2 * 1024 * 1024);
        }
        if (!playlist?.segments) dlFail('HLS 主列表嵌套过深');
        if (expected > 0 && Math.abs(expected - playlist.duration) > Math.max(5, expected * 0.05)) {
            if (strictDuration) {
                dlFail(`播放列表时长 ${dlDurationText(playlist.duration)} 与原视频 ${dlDurationText(expected)} 不符`);
            } else {
                showToast(`列表登记时长(${dlDurationText(expected)})与流时长(${dlDurationText(playlist.duration)})有差异，已按实际流下载`, 3000);
            }
        }
        const parts = [], keys = new Map(), count = playlist.segments.length; let size = 0;
        try {
            for (let i = 0; i < count; i += 3) {
                const batch = await Promise.all(playlist.segments.slice(i, i + 3).map(p => dlSegment(p, job, keys)));
                for (const bytes of batch) { dlCheck(job); size += bytes.length; if (size > DL_LIMIT) dlFail('原始媒体超过 512 MiB'); parts.push(bytes); }
                const warn = size > DL_WARN_LIMIT ? '（体积较大，请保持前台）' : '';
                dlStatus(`下载分片 ${Math.min(i + 3, count)}/${count} · ${(size / 1048576).toFixed(1)} MiB${warn}`, Math.min(i + 3, count) / count * 82);
            }
            const tsHolder = { ts: new Blob(parts, { type: 'video/mp2t' }) }; parts.length = 0;
            dlCheck(job); return await dlRemux(tsHolder, playlist.duration, job);
        } finally { keys.clear(); parts.length = 0; }
    }
    async function dlProbe(blob, expected, job) {
        const v = document.createElement('video'), url = URL.createObjectURL(blob);
        v.preload = 'metadata'; v.muted = true; v.playsInline = true;
        v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
        // 挂载到 DOM 树，避免 iOS Safari 挂起离屏 <video> 的 metadata 解析。
        v.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
        (document.body || document.documentElement).appendChild(v);
        try {
            const actual = await new Promise((resolve, reject) => {
                const finish = (err) => { clearTimeout(timer); job.controller.signal.removeEventListener('abort', abort); v.onloadedmetadata = v.onerror = null; err ? reject(err) : resolve(v.duration); };
                const abort = () => finish(new DOMException('下载已取消', 'AbortError'));
                const timer = setTimeout(() => finish(new Error('Safari 无法及时读取生成文件的媒体信息')), 15000);
                v.onloadedmetadata = () => { if (!v.videoWidth || !v.videoHeight) finish(new Error('输出文件没有可识别的视频画面')); else finish(); };
                v.onerror = () => finish(new Error('Safari 无法识别生成的 MP4'));
                job.controller.signal.addEventListener('abort', abort, { once: true });
                v.src = url; v.load();
            });
            dlDurationCheck(actual, expected, 'Safari 读取到的文件时长异常，已拒绝保存');
            return actual;
        } finally { v.removeAttribute('src'); v.load(); v.remove(); URL.revokeObjectURL(url); }
    }
    async function dlStart() {
        if (!dlSource || dlJob) return;
        const source = dlSource, token = getToken();
        if (!token || token !== source.token) return dlStatus('登录状态已改变，请重新打开视频');
        dlClearPreview();
        if (dlFile) { dlFile = null; if (dlObjectUrl) URL.revokeObjectURL(dlObjectUrl); dlObjectUrl = ''; }
        const job = { controller: new AbortController(), token }; dlJob = job; dlButtons();
        dlStatus('正在检查媒体格式...');
        try {
            const originalDuration = dlEl('ek-video')?.duration;
            const hasRealVideoDuration = Number.isFinite(originalDuration) && originalDuration > 0;
            const expected = hasRealVideoDuration ? originalDuration : (Number(source.duration) || 0);
            const url = dlUrl(source.url, location.href), isMp4 = /\.mp4$/i.test(new URL(url).pathname);
            let first = await dlRead(url, job, isMp4 ? DL_LIMIT : 2 * 1024 * 1024);
            let result;
            if (isMp4 || (first.bytes.length >= 12 && String.fromCharCode(...first.bytes.subarray(4, 8)) === 'ftyp')) {
                const boxes = dlBoxes(first.bytes);
                if (!boxes.some(b => b.type === 'moov') || !boxes.some(b => b.type === 'mdat')) dlFail('不是完整 MP4 文件');
                result = { blob: new Blob([first.bytes], { type: 'video/mp4' }), duration: hasRealVideoDuration ? expected : 0 };
                first = null;
            } else {
                const firstRef = first;
                first = null;
                result = await dlHls(firstRef, job, expected, hasRealVideoDuration);
            }
            dlCheck(job); dlStatus('正在验证 MP4 时长和视频轨...', 98);
            const actual = await dlProbe(result.blob, result.duration, job); dlCheck(job);
            const name = (source.title || '课程视频').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120).replace(/\.mp4$/i, '') + '.mp4';
            dlFile = new File([result.blob], name, { type: 'video/mp4' });
            dlStatus(`已生成 · ${formatDuration(actual)} · ${(dlFile.size / 1048576).toFixed(1)} MiB，请先预览音画，再保存`, 100);
        } catch (e) {
            if (job === dlJob) dlStatus((e.name === 'AbortError' || job.controller.signal.aborted) ? '下载已取消' : `下载失败：${String(e.message || '未知错误').replace(/https?:\/\/[^\s]+/gi, '[媒体地址已隐藏]').slice(0, 400)}`);
        } finally {
            job.controller.abort();
            if (job === dlJob) { dlJob = null; dlResetCloseConfirm(); dlButtons(); }
        }
    }
    function dlSave() {
        const source = dlSource; if (!dlFile || !source || getToken() !== source.token) return;
        if (dlObjectUrl) URL.revokeObjectURL(dlObjectUrl);
        dlObjectUrl = URL.createObjectURL(dlFile);
        const a = document.createElement('a'); a.href = dlObjectUrl; a.download = dlFile.name; document.body.appendChild(a); a.click(); a.remove();
        // 保留对象地址直到关闭播放器/切换视频，避免 iOS 异步读取时提前释放。
        showToast('已交给 Safari 下载，请在文件 App 查看');
    }
    async function dlShare() {
        const source = dlSource; if (!dlFile || !source || getToken() !== source.token) return;
        try {
            const data = { files: [dlFile] };
            if (!navigator.canShare || !navigator.canShare(data)) return showToast('系统不支持分享此文件，请使用保存 MP4');
            await navigator.share(data);
        } catch (e) { if (e.name !== 'AbortError') showToast('系统分享失败，请使用保存 MP4'); }
    }

    // ====== 12. 动态获取视频播放地址并播放 ======
    async function playVideoByIndex(index) {
        if (dlJob) {
            showToast('视频正在下载，请等待完成或先点击取消');
            return;
        }
        const item = currentVideos[index];
        if (!item) return;

        if (!item.videoId) {
            showToast('该条目缺少视频 ID，请切回原网页查看');
            return;
        }

        const video = document.getElementById('ek-video');
        if (currentVideoIndex >= 0 && currentVideos[currentVideoIndex] && video.currentTime > 0) {
            const prevItem = currentVideos[currentVideoIndex];
            saveVideoProgress(prevItem.resourceId, video.currentTime, video.duration || prevItem.duration || 0);
            refreshRowResumeBadge(prevItem.resourceId);
        }

        dlReset();
        currentVideoIndex = index;
        hasRestoredTime = false;
        const reqId = ++activePlayRequestId;

        const modal = document.getElementById('ek-player-modal');
        const logEl = document.getElementById('ek-player-log');

        document.getElementById('ek-player-title').textContent = item.title;
        updateNavButtons();
        updateSpeedPills();

        localStorage.setItem(STORAGE_KEYS.lastPlayed, item.resourceId);
        document.querySelectorAll('#ek-view-detail .ek-last-tag').forEach(t => t.remove());
        const activeMeta = findResMetaById(item.resourceId);
        if (activeMeta) {
            const tag = document.createElement('span');
            tag.className = 'ek-tag ek-last-tag';
            tag.textContent = '上次观看';
            activeMeta.appendChild(tag);
        }

        video.pause();
        video.removeAttribute('src');
        video.load();
        logEl.textContent = '正在请求视频播放地址...';
        modal.style.display = 'flex';

        try {
            const token = getToken();
            if (!token) throw new Error('当前未登录，请重新登录');
            const qs = new URLSearchParams({
                token: token,
                video_id: item.videoId,
                resource_id: item.resourceId
            });
            const apiUrl = `https://cloud-api.easyketang.com/admin/resource_lite/get_url?${qs.toString()}`;
            const res = await rawFetch(apiUrl);
            const json = await res.json();

            if (reqId !== activePlayRequestId) return;

            if (json.status !== 1 || !json.data || !json.data.playURL) {
                throw new Error(json.message || '未获取到播放地址');
            }

            if (token !== capturedToken || isOnPublicOrAuthPage()) return;
            const apiDuration = Number(json.data.times) || Number(json.data.duation) || Number(item.duration) || 0;
            dlSource = { url: json.data.playURL, title: item.title, duration: apiDuration, token };
            dlStatus('已就绪，可下载'); dlButtons();
            logEl.textContent = '已获取流地址，正在缓冲...';
            video.src = json.data.playURL;
            video.playbackRate = preferredRate;
            video.load();
            video.play().catch(() => {
                logEl.textContent = `已载入（${preferredRate}x），请点画面中央播放键开始`;
            });
        } catch (err) {
            if (reqId !== activePlayRequestId) return;
            logEl.textContent = `地址获取失败：${err.message}`;
            showToast('获取视频地址失败，请检查登录状态');
        }
    }

    function refreshRowResumeBadge(resourceId) {
        const meta = findResMetaById(resourceId);
        if (!meta) return;
        const oldTag = meta.querySelector('.ek-resume-tag');
        const saved = getVideoProgress(resourceId);
        if (saved && saved.time >= 5) {
            const label = `看到 ${formatDuration(saved.time)}`;
            if (oldTag) {
                oldTag.textContent = label;
            } else {
                const tag = document.createElement('span');
                tag.className = 'ek-tag ek-resume-tag';
                tag.textContent = label;
                meta.insertBefore(tag, meta.querySelector('.ek-last-tag'));
            }
        } else if (oldTag) {
            oldTag.remove();
        }
    }

    function closePlayer() {
        dlReset();
        activePlayRequestId++;
        const video = document.getElementById('ek-video');
        if (video) {
            if (currentVideoIndex >= 0 && currentVideos[currentVideoIndex] && video.currentTime > 0) {
                const item = currentVideos[currentVideoIndex];
                saveVideoProgress(item.resourceId, video.currentTime, video.duration || item.duration || 0);
                refreshRowResumeBadge(item.resourceId);
            }
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
        const modal = document.getElementById('ek-player-modal');
        if (modal) modal.style.display = 'none';
    }

    // ====== 13. 监听 SPA 路由切换与挂载 ======
    function hookHistory() {
        const wrap = (fnName) => {
            const orig = history[fnName];
            if (typeof orig !== 'function') return;
            history[fnName] = function () {
                const ret = orig.apply(this, arguments);
                setTimeout(syncLoginVisibility, 60);
                return ret;
            };
        };
        wrap('pushState');
        wrap('replaceState');
        window.addEventListener('hashchange', () => setTimeout(syncLoginVisibility, 60));
        window.addEventListener('popstate', () => setTimeout(syncLoginVisibility, 60));
    }

    function init() {
        buildUI();
        hookHistory();
        setInterval(() => {
            if (!document.getElementById('ek-fab')) buildUI();
            syncLoginVisibility();
        }, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();