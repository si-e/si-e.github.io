// ==UserScript==
// @name         MWI 采集器 / 成员资料 · 生活配装 · 战斗配装
// @namespace    https://www.milkywayidle.com/
// @version      3.0.5
// @description  MWI Trial Calculator capture: member profiles, skilling loadouts, combat loadouts. Three buttons, real UI clicks, three JSON exports.
// @description:zh-CN 三条链路，全部模拟真人依次点击：① 成员页采「资料」② 试炼页采「查看配装·生活」③ 试炼页采「查看配装·战斗」。各自导出 JSON，计算器依次导入。
// @author       Guild Tools
// @license      MIT
// @match        https://www.milkywayidle.com/*
// @match        https://test.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://test.milkywayidlecn.com/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// ==/UserScript==

/*
 * v3.0.0 —— 彻底简化：三条链路 · 全部真实点击
 *
 * 之前 v1/v2 用 WS 直发（view_profile / view_loadout），依赖 characterId 映射，
 * 结果「查看配装」经常发不出去、只采到资料。本版放弃直发，改为完全模拟真人：
 * 依次点成员 → 点游戏菜单里的「资料」或「查看配装」，让游戏自己带正确的 id 和
 * kind 发请求，脚本只负责在 WebSocket 上只读地接收回包。
 *
 * 三条链路（三个按钮，各自「采集完自动导出」）：
 *   ① 采集成员资料    ：公会-成员页 → 点每个成员 →「资料」   → profile_shared      → 成员资料 JSON（纯数组）
 *   ② 采集生活配装    ：试炼页生活卡 → 点每个成员 →「查看配装」→ loadout_shared(skilling) → 生活配装 JSON
 *   ③ 采集战斗配装    ：试炼页战斗卡 → 点每个成员 →「查看配装」→ loadout_shared(combat)   → 战斗配装 JSON
 *
 * 分流：点「查看配装」前记下 {name, kind}，回包 loadout_shared 据此落到生活/战斗两个 Map，
 * 同一个人在两类试炼各采一份、互不覆盖。三份 JSON 的计算器导入格式与 v2 完全一致。
 */

(function () {
    'use strict';

    const SCRIPT_VERSION = '3.0.5';
    const STORAGE_KEY = 'mwi-trial-export:v1';

    const T = {
        data: 4200,        // 等 profile_shared / loadout_shared
        tooltip: 2200,     // 等成员 action 菜单弹出
        tileOpen: 2600,    // 点试炼卡后等成员列表
        modalGone: 1000,
        clickGap: 850,     // 点击/请求之间的基准间隔（防「请勿过快」）
        clickGapMax: 2600,
        step: 200,         // 菜单操作间的小延迟
        trialGap: 1800,    // 试炼之间的冷却
    };

    const RATE_LIMIT_RE = /请勿过快|过快发送|too[\s_-]?fast|rate[\s_-]?limit/i;

    const ACTION_LABELS = {
        milking: ['挤奶', 'Milking'], foraging: ['采摘', 'Foraging'],
        woodcutting: ['伐木', 'Woodcutting'], cheesesmithing: ['奶酪锻造', 'Cheesesmithing'],
        crafting: ['制作', 'Crafting'], tailoring: ['缝纫', 'Tailoring'],
        cooking: ['烹饪', 'Cooking'], brewing: ['冲泡', 'Brewing'],
        alchemy: ['炼金', 'Alchemy'], enhancing: ['强化', 'Enhancing'],
        combat: ['战斗', 'Combat'],
    };
    const SKILL_IDS = new Set(Object.keys(ACTION_LABELS).filter((k) => k !== 'combat'));

    const state = {
        ownName: '',
        guild: { name: '', id: '' },
        guildBuildingLevelMap: null,
        memberProfiles: new Map(),   // ① 资料：profile_shared（当前穿戴 + 技能等级）
        skillingLoadouts: new Map(), // ② 生活配装：loadout_shared(kind=skilling)
        combatLoadouts: new Map(),   // ③ 战斗配装：loadout_shared(kind=combat)
        awaitingLoadout: null,       // {name, kind}：点「查看配装」后等待哪一份回包
        trials: [],                  // 试炼元数据（导出用）：{id, action, label, signup, members}
        socket: null,
        seen: new WeakSet(),
        running: false,
        stop: false,
        collecting: false,     // 采集中才剥离 isAuto，避免影响玩家自己的操作
        rewroteAuto: 0,        // 调试计数：剥离了多少个 isAuto
        panel: null,
        pace: T.clickGap,
    };

    // ── 小工具 ────────────────────────────────────────────────
    // 采集面板只在公会页（成员页 / 试炼页）显示，其余页面隐藏。
    // 游戏是 SPA，公会面板动态出现/消失，用 GuildPanel_* 类名判断。
    function isOnGuildPage() {
        return !!document.querySelector('[class*="GuildPanel_membersTable"], [class*="GuildPanel_trialTile"], [class*="GuildPanel_signupModal"]');
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
    const stepDelay = () => sleep(randInt(T.step, T.step + 140));
    const text = (el) => (el && el.textContent || '').trim();
    const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

    function attr(el, name) {
        if (!el) return '';
        return el.getAttribute(name) || el.getAttribute('xlink:' + name)
            || (el.getAttributeNS && el.getAttributeNS('http://www.w3.org/1999/xlink', name)) || '';
    }
    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        try {
            const s = getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
            return el.getBoundingClientRect().width > 0;
        } catch (_) { return false; }
    }
    async function waitFor(fn, { timeout = 3000, interval = 60 } = {}) {
        const t0 = Date.now();
        for (;;) {
            let v = null; try { v = fn(); } catch (_) { /* noop */ }
            if (v) return v;
            if (Date.now() - t0 >= timeout) return null;
            await sleep(interval);
        }
    }

    // 完整鼠标序列（MUI Tooltip 认 mouseover，游戏本体多数认原生 click）
    function clickEl(el) {
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { /* noop */ }
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
        try {
            el.dispatchEvent(new PointerEvent('pointerover', o));
            el.dispatchEvent(new MouseEvent('mouseover', o));
            el.dispatchEvent(new PointerEvent('pointerdown', o));
            el.dispatchEvent(new MouseEvent('mousedown', o));
            el.dispatchEvent(new PointerEvent('pointerup', o));
            el.dispatchEvent(new MouseEvent('mouseup', o));
        } catch (_) { /* 老浏览器 */ }
        try { el.click(); } catch (_) { return false; }
        return true;
    }
    function hoverEl(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        try {
            el.dispatchEvent(new PointerEvent('pointerover', o));
            el.dispatchEvent(new MouseEvent('mouseover', o));
            el.dispatchEvent(new MouseEvent('pointermove', o));
            el.dispatchEvent(new MouseEvent('mousemove', o));
        } catch (_) { return false; }
        return true;
    }
    function pressEsc() {
        const target = (document.activeElement && document.activeElement !== document.body ? document.activeElement : (document.body || document.documentElement));
        const o = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
        try { target.dispatchEvent(new KeyboardEvent('keydown', o)); target.dispatchEvent(new KeyboardEvent('keyup', o)); } catch (_) { /* noop */ }
    }

    // 点击前的节流 + 限速退避（点击也是游戏指令，太快会弹「请勿过快」）
    function rateLimitToast() {
        try {
            for (const n of document.querySelectorAll('[class*="Notification_notification"]')) {
                if (String(n.className || '').includes('Notification_hidden')) continue;
                if (RATE_LIMIT_RE.test(text(n))) return true;
            }
        } catch (_) { /* noop */ }
        return false;
    }
    async function paceGate() {
        if (rateLimitToast()) {
            state.pace = Math.min(T.clickGapMax, Math.round(state.pace * 1.35));
            uiLog(`⚠ 触发限速，间隔升至 ${state.pace}ms，等待 3s…`);
            await sleep(3000);
        }
        await sleep(state.pace * (1 + Math.random() * 0.2));
    }

    // ── WebSocket：只读抓包 ────────────────────────────────────
    function captureGuildInfo(g) {
        if (!g || typeof g !== 'object') return;
        if (g.name && !state.guild.name) state.guild.name = String(g.name);
        if (g.id && !state.guild.id) state.guild.id = String(g.id);
    }
    function handleGameMessage(raw) {
        let obj;
        try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return; }
        if (!obj || !obj.type) return;
        switch (obj.type) {
            case 'init_character_data': {
                if (obj.character?.name) state.ownName = String(obj.character.name);
                captureGuildInfo(obj.character?.guild || obj.guild);
                break;
            }
            case 'guild_updated':
            case 'guild_buildings_updated': {
                const m = obj.guildBuildingLevelMap || obj.guildBuildingLevelDict;
                if (m && typeof m === 'object') state.guildBuildingLevelMap = { ...m };
                captureGuildInfo(obj.guild);
                break;
            }
            case 'profile_shared': {
                const name = obj.profile?.sharableCharacter?.name;
                if (name) state.memberProfiles.set(String(name), obj.profile);
                break;
            }
            case 'loadout_shared': {
                const lo = obj.loadout;
                const name = lo?.sharableCharacter?.name;
                if (!name) break;
                const awaiting = state.awaitingLoadout;
                if (!awaiting) break;
                if (normName(awaiting.name) === normName(name)) {
                    const bucket = awaiting.kind === 'combat' ? state.combatLoadouts : state.skillingLoadouts;
                    bucket.set(String(name), lo);
                    state.awaitingLoadout = null;
                } else {
                    console.log('[MWI Export] 配装回包名字不匹配：期待', awaiting.name, '收到', name);
                }
                break;
            }
            default:
                if (obj.guild) captureGuildInfo(obj.guild);
                break;
        }
    }
    function hookWebSocket() {
        const descriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
        if (!descriptor?.get) { console.error('[MWI Export] MessageEvent.data getter 不可用'); return; }
        const prev = descriptor.get;
        descriptor.get = function () {
            const message = prev.call(this);
            try {
                const socket = this.currentTarget;
                if (socket instanceof WebSocket && /api(?:-test)?\.milkywayidle(?:cn)?\.com\/ws/.test(String(socket.url || ''))) {
                    state.socket = socket;
                    if (!state.seen.has(this)) { state.seen.add(this); handleGameMessage(message); }
                }
            } catch (err) { console.error('[MWI Export] WS 处理异常:', err); }
            return message;
        };
        Object.defineProperty(MessageEvent.prototype, 'data', descriptor);

        // 拿 socket 引用 + 剥离脚本合成点击带来的 isAuto 标记。
        //
        // 关键：油猴脚本用 el.click() 是「不可信事件」(isTrusted=false)，
        // 游戏前端会据此在 view_loadout / view_profile 请求里加 `isAuto:true`；服务端收到
        // 该标记后【不返回】loadout_shared / profile_shared，导致「点了却什么也采不到」。
        // 真人鼠标点击不带 isAuto、有回包。这里在发送前把 isAuto 删掉，等同于真人请求：
        // 点击链路、characterId、kind、context 全部由游戏自己生成，脚本只改这一个标记。
        const origSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
            try {
                const isGameWs = this && /api(?:-test)?\.milkywayidle(?:cn)?\.com\/ws/.test(String(this.url || ''));
                if (isGameWs) {
                    if (!state.socket && this.readyState === 1) state.socket = this;
                    if (typeof data === 'string' && state.collecting && /"isAuto"\s*:\s*true/.test(data)) {
                        try {
                            const o = JSON.parse(data);
                            if ((o.type === 'view_loadout' || o.type === 'view_profile') && o.isAuto) {
                                delete o.isAuto;
                                data = JSON.stringify(o);
                                state.rewroteAuto = (state.rewroteAuto || 0) + 1;
                            }
                        } catch (_) { /* 保持原样 */ }
                    }
                }
            } catch (_) { /* noop */ }
            return origSend.call(this, data);
        };
    }

    // ── DOM：名单 / 弹窗 / 成员菜单 ─────────────────────────────
    function findTrialModal() {
        const list = [...document.querySelectorAll('[class*="GuildPanel_signupModal"]')].filter(isVisible);
        return list[list.length - 1] || null;
    }
    function trialTiles() {
        for (const sel of ['[class*="GuildPanel_trialTile"]', '[class*="trialTile"]']) {
            const list = [...document.querySelectorAll(sel)]
                .filter((el) => isVisible(el) && !el.closest('[id^="mwi-capture"]'));
            if (list.length) return list;
        }
        return [];
    }
    function readTileInfo(tile) {
        const name = text(tile.querySelector('[class*="GuildPanel_tileName"]'));
        const roster = text(tile.querySelector('[class*="GuildPanel_tileRoster"]'));
        const use = tile.querySelector('svg use');
        const iconName = (attr(use, 'href').split('#')[1] || '').trim();
        const m = roster.match(/(\d+)\s*\/\s*(\d+)/);
        return { name, iconName, status: text(tile.querySelector('[class*="tileStatus"]')), signup: m ? `${m[1]} / ${m[2]}` : roster };
    }
    function readTrialMembers(root) {
        const members = [];
        for (const row of root.querySelectorAll('[class*="GuildPanel_memberRow"]')) {
            const name = text(row.querySelector('[class*="GuildPanel_memberName"]'));
            if (!name) continue;
            const lv = (text(row).match(/Lv\.?\s*(\d+)/i) || [])[1];
            members.push({ name, level: lv ? Number(lv) : 0 });
        }
        return members;
    }
    function resolveTrial(info) {
        const icon = (info.iconName || '').toLowerCase().replace(/[-_]/g, '');
        const name = String(info.name || '').toLowerCase();
        for (const id of SKILL_IDS) {
            const norm = id.replace(/[-_]/g, '');
            if (icon === norm || icon.includes(norm)) return { id, action: id };
        }
        if (/combat|battle|战斗/.test(icon) || /战斗/.test(name)) return { id: 'combat', action: 'combat' };
        for (const [id, labels] of Object.entries(ACTION_LABELS)) {
            if (id === 'combat') continue;
            if (labels.some((l) => name.includes(String(l).toLowerCase()))) return { id, action: id };
        }
        const action = SKILL_IDS.has(icon) ? icon : 'combat';
        return { id: icon || slug(info.name) || 'trial', action };
    }
    // 关键：按 kind 筛选卡片。打开卡片时必须用「同类筛选后的列表」按索引取，
    // 否则 targets[t]（同类第 t 张）会错点到全量的第 t 张（往往是别类试炼）。
    function tilesForKind(list, kind) {
        const out = [];
        for (const tile of list) {
            const info = readTileInfo(tile);
            const action = resolveTrial(info).action;
            if ((kind === 'combat') === (action === 'combat')) out.push({ tile, info, action });
        }
        return out;
    }
    function slug(s) { return String(s || '').trim().toLowerCase().replace(/[\s/\\:*?"<>|]+/g, '_').slice(0, 24); }
    function closeBtnOf(root) {
        if (!root) return null;
        return root.querySelector('[class*="closeIcon" i],[class*="closeButton" i],button[aria-label*="lose" i],button[aria-label*="关"]') || null;
    }
    function closeTrialModal() {
        const modal = findTrialModal();
        if (!modal) return true;
        const dlg = modal.closest('[class*="Modal_modal"]') || modal.closest('[role="dialog"]') || modal;
        const btn = closeBtnOf(dlg);
        if (btn) clickEl(btn); else pressEsc();
        return false;
    }
    // 点「资料 / 查看配装」弹出的配装窗（与试炼弹窗是不同层，关它不会关试炼弹窗）
    function findDataOverlay() {
        const list = [...document.querySelectorAll('[class*="SharableProfile_modalContent"],[class*="SharableLoadout_modalContent"]')].filter(isVisible);
        return list[list.length - 1] || null;
    }
    async function closeDataOverlay() {
        for (let i = 0; i < 5; i++) {
            const page = findDataOverlay();
            if (!page) break;
            const dlg = page.closest('[class*="Modal_modal"]') || page.closest('[role="dialog"]');
            const btn = closeBtnOf(dlg);
            if (btn) clickEl(btn); else pressEsc();
            await sleep(150);
        }
        // 配装大窗关掉后，成员小窗（MUI Tooltip）也要清掉，否则下一个成员会串到旧小窗
        closeMemberMenu();
        return true;
    }

    // 关掉成员名点开的「小窗」：MUI Tooltip / GuildPanel_memberActionMenu。
    // 这是独立于配装大窗的一层；真人点别处或 ESC 会让它消失，脚本必须显式清掉。
    function closeMemberMenu() {
        let n = 0;
        for (const tip of document.querySelectorAll('[class*="MuiTooltip-tooltip"],[class*="GuildPanel_memberActionMenu"]')) {
            if (!isVisible(tip)) continue;
            pressEsc();
            try { tip.remove(); n++; } catch (_) { /* noop */ }
        }
        return n;
    }

    function findMemberMenu(name) {
        const wn = normName(name);
        const tips = [...document.querySelectorAll('[class*="MuiTooltip-tooltip"],[class*="GuildPanel_memberActionMenu"]')].filter(isVisible);
        for (const tip of tips) {
            const nEl = tip.querySelector('[class*="CharacterName_name"]');
            const dn = nEl?.getAttribute('data-name') || text(nEl);
            // 必须精确匹配当前成员名；绝不返回别人的残留小窗（否则串台采错人）
            if (normName(dn) === wn) return tip;
        }
        return null;
    }
    function findButtonByText(root, labels) {
        if (!root) return null;
        for (const b of root.querySelectorAll('button,[role="button"],[class*="Button_"]')) {
            const t = text(b);
            if (t && labels.some((l) => t === l || t.includes(l))) return b;
        }
        return null;
    }
    // 全局找成员名元素：试炼弹窗优先，其次整页（公会成员表格）
    function findMemberNameEl(name) {
        const scopes = [];
        const modal = findTrialModal();
        if (modal) scopes.push(modal);
        scopes.push(document);
        for (const scope of scopes) {
            for (const el of scope.querySelectorAll('[data-name]')) {
                if (isVisible(el) && (el.getAttribute('data-name') || '').trim() === name) return el;
            }
            for (const el of scope.querySelectorAll('[class*="GuildPanel_memberName"],[class*="memberName"]')) {
                if (isVisible(el) && text(el) === name) return el;
            }
        }
        return null;
    }
    async function scrollToFindMember(name) {
        const modal = findTrialModal();
        const list = modal?.querySelector('[class*="GuildPanel_memberList"]') || modal;
        if (!list) return null;
        const max = list.scrollHeight - list.clientHeight;
        if (!(max > 4)) return null;
        for (let p = 0; p <= 1.0001; p += 0.34) {
            list.scrollTop = Math.round(max * p);
            await sleep(60);
            const el = findMemberNameEl(name);
            if (el) return el;
        }
        return null;
    }
    function extractGuildMemberNames() {
        const names = [];
        for (const row of document.querySelectorAll('[class*="GuildPanel_membersTable"] tbody tr')) {
            const td = row.querySelector('[class*="name" i]') || row.querySelector('td');
            if (!td) continue;
            const span = td.querySelector('[data-name]');
            let name = '';
            if (span) name = span.getAttribute('data-name') || (span.textContent || '').trim();
            else {
                for (const s of td.querySelectorAll('span')) {
                    const t = (s.textContent || '').trim();
                    if (t && t.length < 30) { name = t; break; }
                }
                if (!name) name = (td.textContent || '').trim().split(/\s+/)[0] || '';
            }
            if (name) names.push(name);
        }
        return [...new Set(names)];
    }

    // 打开某成员的 action 菜单（点名字；必要时点父行 / hover 兜底）
    async function openMemberMenu(name) {
        // 先清掉上一人残留的小窗，否则会点到旧小窗（串台采成上一个人）
        closeMemberMenu();
        let el = findMemberNameEl(name) || await scrollToFindMember(name);
        if (!el) return null;
        clickEl(el);
        let menu = await waitFor(() => findMemberMenu(name), { timeout: T.tooltip });
        if (!menu) {
            const row = el.closest('tr') || el.parentElement;
            if (row && row !== el) {
                clickEl(row);
                menu = await waitFor(() => findMemberMenu(name), { timeout: T.tooltip });
            }
        }
        if (!menu) { hoverEl(el); menu = await waitFor(() => findMemberMenu(name), { timeout: T.tooltip }); }
        return menu;
    }

    // ── 三条采集链路的核心：点一个成员 ──────────────────────────
    async function clickOneProfile(name) {
        if (state.memberProfiles.has(name)) return { ok: true, reason: '已采' };
        const menu = await openMemberMenu(name);
        if (menu) {
            const btn = findButtonByText(menu, ['资料', '查看资料', 'Profile']);
            if (btn) clickEl(btn);
        }
        const got = await waitFor(() => state.memberProfiles.get(name), { timeout: T.data });
        await closeDataOverlay();
        await stepDelay();
        if (!got) return { ok: false, reason: menu ? '未收到资料' : '成员菜单没弹出' };
        return { ok: true, reason: `${Object.keys(got.wearableItemMap || {}).length} 槽` };
    }
    async function clickOneLoadout(name, kind) {
        const bucket = kind === 'combat' ? state.combatLoadouts : state.skillingLoadouts;
        if (bucket.has(name)) return { ok: true, reason: '已采' };
        const menu = await openMemberMenu(name);
        if (!menu) return { ok: false, reason: '成员菜单没弹出' };
        const btn = findButtonByText(menu, ['查看配装', 'View Loadout', 'Loadout', '配装']);
        if (!btn) {
            const labels = [...menu.querySelectorAll('button,[role="button"],[class*="Button_"]')].map((b) => text(b)).filter(Boolean);
            console.log('[MWI Export] 成员菜单无「查看配装」按钮：', name, labels);
            return { ok: false, reason: '没有「查看配装」按钮' };
        }
        state.awaitingLoadout = { name, kind };
        clickEl(btn);
        const got = await waitFor(() => bucket.get(name), { timeout: T.data });
        state.awaitingLoadout = null;
        await closeDataOverlay();
        await stepDelay();
        if (!got) return { ok: false, reason: '未收到配装回包' };
        return { ok: true, reason: `${Object.keys(got.wearableItemMap || {}).length} 槽` };
    }

    // 进度通用循环
    async function loopWithProgress(items, fn, title) {
        let done = 0, fail = 0;
        const failed = [];
        for (let i = 0; i < items.length; i++) {
            if (state.stop) break;
            await paceGate();
            const item = items[i];
            const name = typeof item === 'string' ? item : item.name;
            uiStatus(`${title} ${done + fail + 1}/${items.length} · ${name}`, 'busy');
            const r = await fn(item);
            if (r.ok) done++;
            else { fail++; failed.push(`${name}（${r.reason}）`); uiLog(`  ✗ ${name}：${r.reason}`); }
            if ((done + fail) % 5 === 0) uiLog(`${title} 进度 ${done + fail}/${items.length} · 成功 ${done} 失败 ${fail}`);
        }
        await closeDataOverlay();
        return { done, fail, failed };
    }

    // ① 成员资料（公会-成员页）
    async function runMemberProfiles() {
        if (state.running) return;
        const names = extractGuildMemberNames();
        if (!names.length) { alert('没读到成员名单。\n\n请先切到游戏里「公会 - 成员」页，再点「采集成员资料」。'); return; }
        state.running = true; state.stop = false; state.collecting = true; state.rewroteAuto = 0; state.pace = T.clickGap;
        try {
            uiLog(`【成员资料】开始，共 ${names.length} 人（逐个点击「资料」）`);
            const r = await loopWithProgress(names, clickOneProfile, '成员资料');
            uiLog(`【成员资料】完成：成功 ${r.done} 失败 ${r.fail}`);
            if (r.failed.length) uiLog('未采全：' + r.failed.slice(0, 12).join('、') + (r.failed.length > 12 ? ' …' : ''));
            if (state.memberProfiles.size) exportMemberProfiles();
            else uiStatus('没采到资料，未导出', 'error');
        } catch (err) { console.error(err); uiStatus('出错：' + (err?.message || err), 'error'); }
        finally { state.running = false; state.collecting = false; }
    }

    // ②③ 试炼配装：打开本类试炼卡 → 逐个点成员「查看配装」
    async function runTrialLoadouts(kind) {
        if (state.running) return;
        const tiles = trialTiles();
        if (!tiles.length) { alert('没找到试炼卡片。\n\n请先切到游戏里「公会 - 试炼」页，再点对应按钮。'); return; }
        const targets = tilesForKind(tiles, kind);
        const label = kind === 'combat' ? '战斗配装' : '生活配装';
        if (!targets.length) { alert(`当前试炼页没有${label}对应的试炼卡片。`); return; }

        state.running = true; state.stop = false; state.collecting = true; state.rewroteAuto = 0; state.pace = T.clickGap;
        try {
            uiLog(`【${label}】${targets.length} 场试炼：` + targets.map((x) => `${x.info.name || '?'}[${x.action}]`).join('、'));
            uiLog(`【${label}】逐个点击「查看配装」`);
            let totalDone = 0, totalFail = 0;
            for (let t = 0; t < targets.length; t++) {
                if (state.stop) break;
                // 只能从「同类筛选后」的列表里按索引取；再按名字二次校正，杜绝点到别类试炼
                const fresh = tilesForKind(trialTiles(), kind);
                let cur = fresh[t] || targets[t];
                const wanted = String(targets[t].info.name || '').trim();
                if (wanted) {
                    const byName = fresh.find((x) => String(x.info.name || '').trim() === wanted);
                    if (byName) cur = byName;
                }
                const tile = cur.tile;
                const info = cur.info;
                uiStatus(`打开试炼 ${t + 1}/${targets.length} · ${info.name || ''}`, 'busy');
                uiLog(`→ 打开试炼「${info.name || '?'}」(${cur.action})`);
                clickEl(tile);
                // 真实游戏：点卡后先弹空壳，成员行是异步渲染的。必须等到成员行出现，
                // 否则 readTrialMembers 读到 0 人，整个循环被 continue 跳过（看起来像"没点成员名"）。
                const modal = await waitFor(() => {
                    const m = findTrialModal();
                    if (!m) return null;
                    return m.querySelector('[class*="GuildPanel_memberRow"]') ? m : null;
                }, { timeout: T.tileOpen });
                if (!modal) { uiLog(`✗ ${info.name || '试炼' + (t + 1)} 打不开/成员未加载`); pressEsc(); await stepDelay(); continue; }
                // 再保险等一小段，确保成员行全部渲染完（含 Lv 文本）
                await sleep(200);
                let members = readTrialMembers(modal);
                if (!members.length) {
                    members = await waitFor(() => {
                        const m = findTrialModal();
                        const got = m ? readTrialMembers(m) : [];
                        return got.length ? got : null;
                    }, { timeout: T.tileOpen }) || [];
                }
                upsertTrial({ name: info.name, iconName: info.iconName, signup: info.signup, action: cur.action }, members);
                if (!members.length) { uiLog(`✗ ${info.name || '试炼'} 成员列表为空，跳过`); closeTrialModal(); await sleep(T.modalGone); continue; }
                uiLog(`  ${info.name || '试炼'} 读到 ${members.length} 名成员，开始逐个点「查看配装」`);
                const r = await loopWithProgress(members, (m) => clickOneLoadout(m.name, kind), label);
                totalDone += r.done; totalFail += r.fail;
                if (r.failed.length) uiLog(`  ${info.name || '试炼'} 未采全：` + r.failed.slice(0, 8).join('、'));
                closeTrialModal();
                await waitFor(() => !findTrialModal(), { timeout: T.modalGone });
                if (t < targets.length - 1 && !state.stop) { await sleep(T.trialGap); }
            }
            uiLog(`【${label}】完成：成功 ${totalDone} 失败 ${totalFail}`);
            const bucket = kind === 'combat' ? state.combatLoadouts : state.skillingLoadouts;
            if (bucket.size) { kind === 'combat' ? exportCombat() : exportSkilling(); }
            else uiStatus(`没采到${label}，未导出`, 'error');
        } catch (err) { console.error(err); uiStatus('出错：' + (err?.message || err), 'error'); }
        finally { state.running = false; state.collecting = false; }
    }

    function upsertTrial(info, members) {
        const { id, action } = resolveTrial(info);
        const exist = state.trials.find((t) => t.id === id);
        if (exist) {
            const have = new Set(exist.members.map((m) => m.name));
            for (const m of members) if (!have.has(m.name)) exist.members.push(m);
            return exist;
        }
        state.trials.push({ id, action, label: info.name || action, signup: info.signup || '', members });
    }
    function trialsOfMember(name) {
        return state.trials.filter((t) => t.members.some((m) => m.name === name)).map((t) => t.id);
    }
    // 试炼的 action 是具体技能（milking/foraging…）或 'combat'，而配装 kind 只有 skilling/combat。
    // 生活类 = 一切非 combat 的试炼，不能拿 t.action === 'skilling' 去比（那永远为空）。
    function trialIsKind(t, kind) {
        return kind === 'combat' ? t.action === 'combat' : t.action !== 'combat';
    }

    // ── 导出（格式与 v2/计算器完全一致）────────────────────────
    function downloadJSON(filename, data) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
    }
    function filePrefix(label, n) {
        const g = String(state.guild.name || 'guild').replace(/[\\/:*?"<>|]/g, '_');
        return `MWI_${label}_${g}_${n}人_${new Date().toISOString().slice(0, 10)}.json`;
    }

    // ① 成员资料：纯数组，计算器 ② 分支直接吃
    function exportMemberProfiles() {
        const arr = [...state.memberProfiles.values()].map((p) => Object.assign({}, p, { _trials: trialsOfMember(p.sharableCharacter?.name) }));
        const gb = state.guildBuildingLevelMap;
        if (arr.length && gb && Object.keys(gb).length) arr[0] = Object.assign({}, arr[0], { _guildBuildingLevelMap: { ...gb } });
        downloadJSON(filePrefix('成员资料', arr.length), arr);
        uiStatus(`已导出成员资料 ${arr.length} 人`, 'ok');
        uiLog('在计算器里导入这份「成员资料」，再导入生活/战斗配装（三份按名字合并）。');
    }

    // ②③ 配装：buildLoadoutExport 的 _format/trials/members 结构保持原样
    function buildLoadoutExport(bucket, format, kind) {
        const members = [...bucket.entries()].map(([name, lo]) => Object.assign({}, lo, {
            _trials: state.trials.filter((t) => trialIsKind(t, kind) && t.members.some((m) => m.name === name)).map((t) => t.id),
        }));
        const gb = state.guildBuildingLevelMap;
        return {
            _format: format, _version: 1, scriptVersion: SCRIPT_VERSION,
            exportedAt: new Date().toISOString(), source: location.hostname,
            equipmentSource: 'loadout_shared.wearableItemMap', loadoutKind: kind,
            guild: { ...state.guild },
            guildBuildingLevelMap: gb && Object.keys(gb).length ? { ...gb } : null,
            trials: state.trials.filter((t) => trialIsKind(t, kind)).map((t) => ({
                key: t.id, label: t.label, signup: t.signup || '', members: t.members.map((m) => m.name),
            })),
            members,
        };
    }
    function exportSkilling() {
        const data = buildLoadoutExport(state.skillingLoadouts, 'mwi-skilling-loadouts', 'skilling');
        downloadJSON(filePrefix('生活试炼配装', data.members.length), data);
        uiStatus(`已导出生活配装 ${data.members.length} 人 / ${data.trials.length} 场`, 'ok');
    }
    function exportCombat() {
        const data = buildLoadoutExport(state.combatLoadouts, 'mwi-combat-loadouts', 'combat');
        downloadJSON(filePrefix('战斗试炼配装', data.members.length), data);
        uiStatus(`已导出战斗配装 ${data.members.length} 人 / ${data.trials.length} 场`, 'ok');
    }

    // ── UI：极简面板，三条链路，常驻显示 ────────────────────────
    function uiLog(msg) {
        const box = state.panel?.querySelector('.mc-log');
        if (box) {
            const line = document.createElement('div');
            line.textContent = msg;
            box.appendChild(line);
            while (box.childElementCount > 120) box.removeChild(box.firstChild);
            box.scrollTop = box.scrollHeight;
        }
        console.log('[MWI Export]', msg);
    }
    function uiStatus(msg, kind) {
        const el = state.panel?.querySelector('.mc-status');
        if (el) { el.textContent = msg; el.dataset.kind = kind || ''; }
        refreshCounts();
    }
    function refreshCounts() {
        const set = (sel, n) => { const e = state.panel?.querySelector(sel); if (e) e.textContent = String(n); };
        set('.mc-n1', state.memberProfiles.size);
        set('.mc-n2', state.skillingLoadouts.size);
        set('.mc-n3', state.combatLoadouts.size);
    }
    function injectCSS() {
        if (document.getElementById('mwi-capture-css')) return;
        const style = document.createElement('style');
        style.id = 'mwi-capture-css';
        style.textContent = `
#mwi-capture{position:fixed;right:14px;bottom:14px;z-index:2147483647;width:262px;
  font:12px/1.55 system-ui,"Microsoft YaHei",sans-serif;color:#e8eef6;
  background:#151d2a;border:1px solid #33425a;border-radius:12px;
  box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden}
#mwi-capture *{box-sizing:border-box}
#mwi-capture .mc-head{display:flex;align-items:center;gap:8px;padding:10px 12px;
  background:#1e2a3b;border-bottom:1px solid #2c3a50;cursor:move;user-select:none}
#mwi-capture .mc-title{font-weight:700;font-size:13px}
#mwi-capture .mc-ver{opacity:.5;font-size:10px}
#mwi-capture .mc-min{margin-left:auto;cursor:pointer;opacity:.7;padding:0 6px;font-size:16px;line-height:1}
#mwi-capture .mc-body{padding:10px 12px 12px}
#mwi-capture .mc-status{padding:7px 9px;border-radius:7px;background:#223049;font-size:11px;
  min-height:30px;margin-bottom:10px;color:#cfe0f5}
#mwi-capture .mc-status[data-kind=ok]{background:#17402e;color:#8ff0bd}
#mwi-capture .mc-status[data-kind=error]{background:#4a2026;color:#ffb3b9}
#mwi-capture .mc-status[data-kind=busy]{background:#3a3018;color:#ffd98a}
#mwi-capture .mc-sec{margin-bottom:10px}
#mwi-capture .mc-sec-h{font-size:10px;opacity:.55;letter-spacing:.5px;margin:0 0 5px 2px}
#mwi-capture .mc-btn{display:flex;align-items:center;gap:6px;width:100%;padding:9px 10px;margin-bottom:6px;
  border:1px solid #3a4c68;border-radius:8px;background:#263754;color:#eaf1fb;
  font:600 12px/1 system-ui,"Microsoft YaHei",sans-serif;cursor:pointer;text-align:left}
#mwi-capture .mc-btn:hover{background:#31466b}
#mwi-capture .mc-btn:disabled{opacity:.5;cursor:default}
#mwi-capture .mc-btn .mc-ic{width:18px;text-align:center;opacity:.9}
#mwi-capture .mc-btn .mc-count{margin-left:auto;background:#101827;border-radius:10px;
  padding:2px 8px;font-size:11px;color:#9fd0ff}
#mwi-capture .mc-btn.a{background:#215c3c;border-color:#2f7a4f}
#mwi-capture .mc-btn.a:hover{background:#2a724a}
#mwi-capture .mc-btn.b{background:#3a2d63;border-color:#54407f}
#mwi-capture .mc-btn.b:hover{background:#493a79}
#mwi-capture .mc-btn.c{background:#6b3a22;border-color:#8a4d2e}
#mwi-capture .mc-btn.c:hover{background:#7e482b}
#mwi-capture .mc-btn.stop{background:#4a2026;border-color:#6b2d35}
#mwi-capture .mc-log{max-height:130px;overflow:auto;margin-top:8px;padding:8px 9px;
  background:#101724;border-radius:7px;font-size:10.5px;line-height:1.5;color:#9fb2cb;word-break:break-all}
#mwi-capture .mc-log div+div{margin-top:2px}
`;
        document.head.appendChild(style);
    }
    function buildPanel() {
        if (state.panel || !document.body) return;
        injectCSS();
        const wrap = document.createElement('div');
        wrap.id = 'mwi-capture';
        wrap.innerHTML = `
          <div class="mc-head">
            <span class="mc-title">MWI 采集器</span><span class="mc-ver">v${SCRIPT_VERSION}</span>
            <span class="mc-min" title="收起/展开">−</span>
          </div>
          <div class="mc-body">
            <div class="mc-status">就绪</div>
            <div class="mc-sec">
              <div class="mc-sec-h">① 公会 - 成员 页</div>
              <button class="mc-btn a" data-act="profiles"><span class="mc-ic">👤</span>采集成员资料<span class="mc-count mc-n1">0</span></button>
            </div>
            <div class="mc-sec">
              <div class="mc-sec-h">② 公会 - 试炼 页</div>
              <button class="mc-btn b" data-act="skilling"><span class="mc-ic">🌾</span>采集生活配装<span class="mc-count mc-n2">0</span></button>
              <button class="mc-btn c" data-act="combat"><span class="mc-ic">⚔</span>采集战斗配装<span class="mc-count mc-n3">0</span></button>
              <button class="mc-btn stop" data-act="stop"><span class="mc-ic">■</span>停止</button>
            </div>
            <div class="mc-log"></div>
          </div>`;
        document.body.appendChild(wrap);
        state.panel = wrap;

        // 只在公会页显示：游戏是 SPA，公会面板动态出现/消失，用 MutationObserver 防抖跟踪显隐。
        const syncVisibility = () => { wrap.style.display = isOnGuildPage() ? '' : 'none'; };
        let visTimer = null;
        const visObserver = new MutationObserver(() => {
            if (visTimer) return;
            visTimer = setTimeout(() => { visTimer = null; syncVisibility(); }, 300);
        });
        visObserver.observe(document.body, { childList: true, subtree: true });
        syncVisibility();

        wrap.addEventListener('click', (e) => {
            const t = e.target;
            if (t?.classList?.contains('mc-min')) {
                const body = wrap.querySelector('.mc-body');
                const hide = body.style.display !== 'none';
                body.style.display = hide ? 'none' : '';
                t.textContent = hide ? '+' : '−';
                return;
            }
            const btn = t?.closest?.('[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'profiles') runMemberProfiles();
            else if (act === 'skilling') runTrialLoadouts('skilling');
            else if (act === 'combat') runTrialLoadouts('combat');
            else if (act === 'stop') { state.stop = true; uiStatus('正在停止…', 'warn'); }
        });
        // 阻止面板内指针/鼠标事件冒泡到游戏，避免误触游戏操作。
        // 注意：不能拦 mouseup/pointerup —— 拖拽结束依赖 window 捕获阶段的 up 事件；
        // 这里只拦 pointerdown/mousedown（游戏主要响应按下），松开事件一律放行。
        ['pointerdown', 'mousedown'].forEach((ev) => wrap.addEventListener(ev, (e) => {
            if (e.target?.closest?.('input')) return;
            e.stopPropagation();
        }));

        // 标题栏拖拽：用 pointer 事件 + window 捕获监听，保证鼠标移出面板后松开也能收到 up。
        // 之前用 document 冒泡监听，但面板 stopPropagation 了 mouseup，导致 drag 永远清不掉 → 拖不停。
        const head = wrap.querySelector('.mc-head');
        let drag = null;
        const endDrag = () => { drag = null; };
        head.addEventListener('pointerdown', (e) => {
            if (e.target.classList.contains('mc-min')) return;
            if (e.button !== 0) return;            // 只响应主键
            const r = wrap.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
            wrap.style.right = 'auto'; wrap.style.bottom = 'auto';
            wrap.style.left = r.left + 'px'; wrap.style.top = r.top + 'px';
            e.preventDefault();
        });
        // 捕获阶段挂在 window 上，先于任何冒泡阶段的 stopPropagation 执行。
        window.addEventListener('pointermove', (e) => {
            if (!drag) return;
            wrap.style.left = Math.max(0, e.clientX - drag.dx) + 'px';
            wrap.style.top = Math.max(0, e.clientY - drag.dy) + 'px';
        }, true);
        window.addEventListener('pointerup', endDrag, true);
        // 兜底：指针被系统取消、窗口失焦、鼠标移出浏览器窗口时也要结束拖拽。
        window.addEventListener('pointercancel', endDrag, true);
        window.addEventListener('blur', endDrag);
        document.addEventListener('mouseleave', endDrag);
    }

    function clearCache() {
        if (state.running) { alert('采集中，请先停止。'); return; }
        if (!confirm('清空已采集的数据？（导出的文件不受影响）')) return;
        state.memberProfiles.clear();
        state.skillingLoadouts.clear();
        state.combatLoadouts.clear();
        state.awaitingLoadout = null;
        state.trials = [];
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* noop */ }
        refreshCounts();
        uiStatus('已清空缓存', 'ok');
    }

    // ── 启动 ──────────────────────────────────────────────────
    hookWebSocket();
    GM_registerMenuCommand('① 采集成员资料（公会-成员页）', runMemberProfiles);
    GM_registerMenuCommand('② 采集生活配装（公会-试炼页）', () => runTrialLoadouts('skilling'));
    GM_registerMenuCommand('③ 采集战斗配装（公会-试炼页）', () => runTrialLoadouts('combat'));
    GM_registerMenuCommand('清空已采集缓存', clearCache);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel, { once: true });
    else buildPanel();
})();
