// ==UserScript==
// @name         MWI Data Export / 银河奶牛数据导出
// @namespace    https://www.milkywayidle.com/
// @version      0.9.0
// @description  Export your MWI guild members' full profile data (skills + equipment + personal shrine buffs + achievements + guild building levels) to a JSON file for the MWI Trial Calculator.
// @description:zh-CN 导出银河奶牛公会成员的完整数据（技能+装备+个人神龛增益+成就+公会建筑等级）为 JSON 文件，供试炼计算器导入。仅在「公会 - 成员」界面显示按钮：点一下「开始采集公会成员」即逐个采集全部成员（含自己），采集完成后自动导出 JSON。
// @author       Guild Tools (modified)
// @license      MIT
// @match        https://www.milkywayidle.com/*
// @match        https://test.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://test.milkywayidlecn.com/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_VERSION = '0.9.0';
    const EQUIPPED_LOCATION_PREFIX = '/item_locations/';
    const INVENTORY_LOCATION = '/item_locations/inventory';

    const AURA_MAP = Object.freeze({
        revive: '/abilities/revive',
        insanity: '/abilities/insanity',
        invincible: '/abilities/invincible',
        speed: '/abilities/speed_aura',
        guardian: '/abilities/guardian_aura',
        physical: '/abilities/fierce_aura',
        critical: '/abilities/critical_aura',
        elemental: '/abilities/mystic_aura',
    });

    const state = {        character: null,
        skills: new Map(),
        items: new Map(),
        abilities: new Map(),
        dataReady: false,
        cachedProfiles: new Map(),
        // 本次会话累计收到的 profile_shared 次数（重新采集时 Map.size 不会增长，用它判断“又采到一个”）
        captures: 0,
        statusButton: null,
        seenEvents: new WeakSet(),
        mwiSocket: null,
        // 个人神龛增益等级（键 /guild_buffs/<shrine>_skilling，来自 guild_buffs_updated 的 characterGuildBuffMap）
        guildBuffLevelMap: null,
        // 公会建筑等级（键 /guild_buildings/<building>，公会全局，来自 guild_updated 的 guildBuildingLevelMap）
        guildBuildingLevelMap: null,
        // 成就全表（自己角色，来自 init_character_data / achievements_updated；仅用于无采集数据时的兜底）
        achievements: null,
        chatPayloadTemplate: (() => {
            try { return localStorage.getItem('mwi-export:chat-payload-template'); } catch (_) { return null; }
        })(),
    };

    // ── 页面上唯一的按钮（只在「公会 - 成员」界面显示）───────────────
    // 流程：点「开始采集公会成员」→ 逐个采集 → 采集完成自动导出 JSON。
    // 不再区分「重新采集」与「导出」两个按钮，也不再在待机时显示「已缓存 N 人」。
    // 状态机：idle（开始采集）→ running（采集中 x/y）→ done（已导出 N 人）/ error。
    const btnState = { phase: 'idle', sent: 0, total: 0, count: 0 };

    function renderStatus() {
        const b = state.statusButton;
        if (!b) return;
        const colors = {
            idle: ['#3a5fc8', '#ffffff'],
            good: ['#24543a', '#d8ffe8'],
            busy: ['#66511f', '#fff0bd'],
            error: ['#6a2d35', '#ffe0e4'],
        };
        let kind = 'idle';
        let text = '开始采集公会成员';
        if (btnState.phase === 'running') {
            kind = 'busy';
            text = `采集中 ${btnState.sent}/${btnState.total}`;
        } else if (btnState.phase === 'done') {
            kind = 'good';
            text = `已导出 ${btnState.count} 人 · 点此重采`;
        } else if (btnState.phase === 'error') {
            kind = 'error';
            text = '采集失败 · 点此重试';
        }
        const [background, color] = colors[kind] || colors.idle;
        b.textContent = text;
        b.dataset.kind = kind;
        b.style.background = background;
        b.style.color = color;
        b.disabled = btnState.phase === 'running';
    }

    // 只在「公会 - 成员」界面（公会成员表格出现时）显示按钮
    function isOnGuildMembersPage() {
        return !!document.querySelector('[class*="GuildPanel_membersTable"]');
    }

    function syncButtonVisibility() {
        const b = state.statusButton;
        if (!b) return;
        b.style.display = isOnGuildMembersPage() ? '' : 'none';
    }

    function addStatusButton() {
        if (state.statusButton || !document.body) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.title = '在「公会 - 成员」页采集全部成员数据并自动导出 JSON';
        Object.assign(button.style, {
            position: 'fixed',
            zIndex: '2147483647',
            right: '12px',
            bottom: '12px',
            border: '1px solid rgba(255,255,255,.22)',
            borderRadius: '8px',
            padding: '7px 10px',
            fontSize: '12px',
            cursor: 'pointer',
            boxShadow: '0 2px 10px rgba(0,0,0,.3)',
            display: 'none',
        });
        button.addEventListener('click', () => {
            if (btnState.phase === 'running') return;
            autoClickMembers({ force: true });
        });
        document.body.appendChild(button);
        state.statusButton = button;
        renderStatus();

        // 公会是 SPA，成员面板会动态出现 / 消失 —— 用 MutationObserver（防抖）跟踪显隐
        let visTimer = null;
        const observer = new MutationObserver(() => {
            if (visTimer) return;
            visTimer = setTimeout(() => { visTimer = null; syncButtonVisibility(); }, 300);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        syncButtonVisibility();
    }

    function itemKey(item) {
        if (item?.id !== undefined && item?.id !== null) return `id:${item.id}`;
        if (item?.hash) return `hash:${item.hash}`;
        return `loc:${item?.itemLocationHrid || ''}:${item?.itemHrid || ''}`;
    }

    function mergeSkills(skills, replace = false) {
        if (!Array.isArray(skills)) return;
        if (replace) state.skills.clear();
        for (const skill of skills) {
            if (!skill?.skillHrid) continue;
            state.skills.set(skill.skillHrid, {
                level: Number(skill.level || 0),
                experience: Number(skill.experience || 0),
            });
        }
    }

    function mergeItems(items, replace = false) {
        if (!Array.isArray(items)) return;
        if (replace) state.items.clear();
        for (const item of items) {
            if (!item?.itemHrid) continue;
            const key = itemKey(item);
            if (Number(item.count || 0) <= 0) {
                state.items.delete(key);
                for (const [existingKey, existing] of state.items.entries()) {
                    if (existing.itemLocationHrid === item.itemLocationHrid && existing.itemHrid === item.itemHrid) {
                        state.items.delete(existingKey);
                    }
                }
                continue;
            }
            if (item.itemLocationHrid && item.itemLocationHrid !== INVENTORY_LOCATION) {
                for (const [existingKey, existing] of state.items.entries()) {
                    if (existing.itemLocationHrid === item.itemLocationHrid && existingKey !== key) {
                        state.items.delete(existingKey);
                    }
                }
            }
            state.items.set(key, { ...item });
        }
    }

    function mergeAbilities(abilities, replace = false) {
        if (!Array.isArray(abilities)) return;
        if (replace) state.abilities.clear();
        for (const ability of abilities) {
            if (!ability?.abilityHrid) continue;
            const old = state.abilities.get(ability.abilityHrid) || {};
            state.abilities.set(ability.abilityHrid, { ...old, ...ability });
        }
    }


    function handleGameMessage(message) {
        let obj;
        try {
            obj = typeof message === 'string' ? JSON.parse(message) : message;
        } catch {
            return;
        }
        if (!obj?.type) return;

        let changed = false;
        if (obj.type === 'init_character_data') {
            if (!obj.character?.id) return;
            state.character = {
                id: String(obj.character.id),
                name: String(obj.character.name || ''),
                gameMode: String(obj.character.gameMode || ''),
            };
            // 若服务端在角色对象里带了个人神龛增益，一并记下
            const initBuffMap = obj.character.guildBuffLevelMap || obj.character.characterGuildBuffMap;
            if (initBuffMap && typeof initBuffMap === 'object') state.guildBuffLevelMap = { ...initBuffMap };
            // 自己角色的成就全表（个人数据；仅在完全没有采集到成员 profile 时用于兜底）
            const initAch = obj.characterAchievements || obj.character.achievements;
            if (initAch && typeof initAch === 'object') state.achievements = { ...initAch };
            mergeSkills(obj.characterSkills, true);
            mergeItems(obj.characterItems, true);
            mergeAbilities(obj.characterAbilities, true);
            changed = true;
        } else if (obj.type === 'skills_updated') {
            mergeSkills(obj.endCharacterSkills || obj.characterSkills);
            changed = true;
        } else if (obj.type === 'items_updated') {
            mergeItems(obj.endCharacterItems || obj.characterItems);
            changed = true;
        } else if (obj.type === 'abilities_updated') {
            mergeAbilities(obj.endCharacterAbilities || obj.characterAbilities);
            changed = true;
        } else if (obj.type === 'action_completed') {
            if (obj.endCharacterSkills) mergeSkills(obj.endCharacterSkills);
            if (obj.endCharacterItems) mergeItems(obj.endCharacterItems);
            if (obj.endCharacterAbilities) mergeAbilities(obj.endCharacterAbilities);
            changed = Boolean(obj.endCharacterSkills || obj.endCharacterItems || obj.endCharacterAbilities);
        } else if (obj.type === 'achievements_updated') {
            // 成就全表（自己角色）
            const a = obj.characterAchievements || obj.endCharacterAchievements || obj.achievements;
            if (a && typeof a === 'object') { state.achievements = { ...a }; changed = true; }
        }

        // 个人神龛增益等级（自己）：guild_buffs_updated 带 characterGuildBuffMap
        // 键形如 /guild_buffs/force_skilling，与共享资料里的 guildBuffLevelMap 完全一致
        if (obj.type === 'guild_buffs_updated' || obj.type === 'guild_buff_levels_updated') {
            const m = obj.characterGuildBuffMap || obj.guildBuffLevelMap || obj.characterGuildBuffLevelMap;
            if (m && typeof m === 'object') {
                state.guildBuffLevelMap = { ...m };
                changed = true;
            }
        }
        // 公会建筑等级（公会全局）：guild_updated 带 guildBuildingLevelMap
        if (obj.type === 'guild_updated' || obj.type === 'guild_buildings_updated') {
            const m = obj.guildBuildingLevelMap || obj.guildBuildingLevelDict;
            if (m && typeof m === 'object') {
                state.guildBuildingLevelMap = { ...m };
                changed = true;
            }
        }

        if (obj.type === 'profile_shared') {
            const profile = obj.profile;
            const charName = profile?.sharableCharacter?.name;
            if (charName && profile) {
                state.cachedProfiles.set(charName, {
                    name: charName,
                    profile,
                    capturedAt: new Date().toISOString(),
                });
                state.captures = (state.captures || 0) + 1;
            }
        }

        // 注意：待机状态不主动改按钮文案。旧版在这里显示「已缓存 N 人」会让人误以为
        // 采集已完成（而且 N 里还含一个从未被采集过的「自己」）。按钮文案只由采集流程
        // （autoClickMembers）与显隐逻辑驱动。
        if (changed) {
            state.dataReady = true;
        }
    }

    function hookWebSocketMessages() {
        const descriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
        if (!descriptor?.get) {
            console.error('[MWI Guild Sync] MessageEvent.data getter is unavailable.');
            return;
        }
        const previousGetter = descriptor.get;
        descriptor.get = function () {
            const message = previousGetter.call(this);
            try {
                const socket = this.currentTarget;
                if (!(socket instanceof WebSocket)) return message;
                const url = String(socket.url || '');
                if (!/api(?:-test)?\.milkywayidle(?:cn)?\.com\/ws/.test(url)) return message;
                // 顺手记住最近使用的 socket，方便后面通过 WS 直发
                state.mwiSocket = socket;
                if (state.seenEvents.has(this)) return message;
                state.seenEvents.add(this);
                handleGameMessage(message);
            } catch (error) {
                console.error('[MWI Guild Sync] WebSocket processing failed:', error);
            }
            return message;
        };
        Object.defineProperty(MessageEvent.prototype, 'data', descriptor);
    }

    // Hook WebSocket.prototype.send，抓到 MWI 发送 chat 消息时的完整 payload，
    // 用作后续脚本自己构造 /profile 命令的模板（key/format 一致，MWI 无法
    // 识别是脚本还是玩家发出）。捕获到的模板会缓存到 localStorage。
    const CHAT_TEMPLATE_STORAGE_KEY = 'mwi-export:chat-payload-template';
    function hookWebSocketSend() {
        const origSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
            try {
                const url = String(this.url || '');
                if (/api(?:-test)?\.milkywayidle(?:cn)?\.com\/ws/.test(url)) {
                    state.mwiSocket = this;
                    // 非字符串（Blob/ArrayBuffer/protobuf 之类二进制协议）单独提示
                    if (typeof data !== 'string') {
                        console.log('[MWI Export] WS send (non-string):', typeof data,
                            data?.constructor?.name, 'size=', data?.byteLength || data?.size);
                    }
                    // 把所有发出去的短 payload 都打出来，方便手动核对 chat 消息格式
                    if (typeof data === 'string' && data.length < 4096) {
                        console.log('[MWI Export] WS send:', data);

                        // 首选：payload 里字面含 "/profile " —— 一定是用户在
                        // 聊天框敲的 /profile 命令，直接拿来当模板最保险
                        if (data.includes('/profile ') || data.includes('/profile"')) {
                            state.chatPayloadTemplate = data;
                            try { localStorage.setItem(CHAT_TEMPLATE_STORAGE_KEY, data); } catch (_) {}
                            console.log('[MWI Export] ✓ 捕获到 /profile 模板:', data);
                            return origSend.apply(this, arguments);
                        }

                        // 次选：能解析成对象且带斜杠命令或普通聊天字段
                        let parsed = null;
                        try { parsed = JSON.parse(data); } catch (_) { /* 非 JSON 忽略 */ }
                        if (parsed && typeof parsed === 'object') {
                            const stringFields = Object.values(parsed).filter(v => typeof v === 'string');
                            const hasCmdString = stringFields.some(v => v.startsWith('/'));
                            const typeStr = String(parsed.type || '').toLowerCase();
                            const looksLikeChat = hasCmdString
                                || typeStr.includes('chat')
                                || typeStr.includes('message')
                                || typeStr.includes('send')
                                || 'message' in parsed
                                || 'text' in parsed
                                || 'content' in parsed
                                || 'msg' in parsed;
                            if (looksLikeChat) {
                                state.chatPayloadTemplate = data;
                                try { localStorage.setItem(CHAT_TEMPLATE_STORAGE_KEY, data); } catch (_) {}
                                console.log('[MWI Export] ✓ 捕获到 chat payload 模板:', data);
                            }
                        }
                    }
                }
            } catch (_) { /* noop */ }
            return origSend.apply(this, arguments);
        };
    }

    // 从上次捕获的 chat payload 模板出发，把里面的"消息文本"字段替换成新指令。
    // MWI 的 payload 大概率是 { type: "...", message: "/profile xxx", channel?: "..." } 结构，
    // 我们逐个字段找"看起来是消息文本"的 string 字段替换，避免硬编码字段名。
    function buildChatPayloadFromTemplate(template, text) {
        try {
            const obj = JSON.parse(template);
            let replaced = false;
            for (const key of Object.keys(obj)) {
                if (typeof obj[key] === 'string' && (
                    obj[key].startsWith('/') ||
                    key.toLowerCase() === 'message' ||
                    key.toLowerCase() === 'text' ||
                    key.toLowerCase() === 'content'
                )) {
                    obj[key] = text;
                    replaced = true;
                }
            }
            if (!replaced) return null;
            return JSON.stringify(obj);
        } catch (_) {
            return null;
        }
    }

    // 通过 WebSocket 直接发送 chat 指令，绕开 UI 的 isTrusted 校验。
    function sendChatByWebSocket(text) {
        const socket = state.mwiSocket;
        if (!socket || socket.readyState !== 1) {
            console.warn('[MWI Export] WebSocket 未就绪，无法直发');
            return false;
        }
        const template = state.chatPayloadTemplate || (() => {
            try { return localStorage.getItem(CHAT_TEMPLATE_STORAGE_KEY); } catch (_) { return null; }
        })();
        if (!template) {
            console.warn('[MWI Export] 尚未捕获 chat payload 模板，请先手动发送一条聊天/命令让脚本抓取格式');
            return false;
        }
        state.chatPayloadTemplate = template;
        const payload = buildChatPayloadFromTemplate(template, text);
        if (!payload) {
            console.warn('[MWI Export] 无法基于模板构造新 payload:', template);
            return false;
        }
        try {
            socket.send(payload);
            return true;
        } catch (err) {
            console.error('[MWI Export] socket.send 失败:', err);
            return false;
        }
    }

    // MWI 客户端把 /profile 命令翻译成了专用的结构化消息发送，格式如下：
    // { "type": "view_profile", "viewProfileData": { "characterName": "..." }, "ts": <epoch ms> }
    // 直接按这个格式硬编码，装完脚本即可用，无需预热捕获模板。
    function sendViewProfileByWebSocket(characterName) {
        const socket = state.mwiSocket;
        if (!socket || socket.readyState !== 1) {
            console.warn('[MWI Export] WebSocket 未就绪，无法直发');
            return false;
        }
        const payload = JSON.stringify({
            type: 'view_profile',
            viewProfileData: { characterName },
            ts: Date.now(),
        });
        try {
            socket.send(payload);
            return true;
        } catch (err) {
            console.error('[MWI Export] socket.send view_profile 失败:', err);
            return false;
        }
    }

    function buildPayload() {
        if (!state.character) return null;
        const skills = {};
        for (const [hrid, value] of state.skills.entries()) {
            skills[hrid.replace('/skills/', '')] = Number(value.level || 0);
        }

        const equipment = [...state.items.values()]
            .filter(item => item.itemLocationHrid && item.itemLocationHrid !== INVENTORY_LOCATION && Number(item.count || 0) > 0)
            .map(item => ({
                slot: String(item.itemLocationHrid || '').replace(EQUIPPED_LOCATION_PREFIX, ''),
                itemHrid: String(item.itemHrid || ''),
                enhancementLevel: Number(item.enhancementLevel || 0),
            }))
            .sort((a, b) => a.slot.localeCompare(b.slot));

        const abilities = {};
        for (const [hrid, ability] of state.abilities.entries()) {
            abilities[hrid.replace('/abilities/', '')] = {
                level: Number(ability.level || 0),
                slotNumber: Number(ability.slotNumber || 0),
            };
        }

        const auras = {};
        for (const [label, hrid] of Object.entries(AURA_MAP)) {
            auras[label] = Number(state.abilities.get(hrid)?.level || 0);
        }

        return {
            schemaVersion: 1,
            scriptVersion: SCRIPT_VERSION,
            character: { ...state.character },
            skills,
            equipment,
            abilities,
            auras,
            achievements: state.achievements ? { ...state.achievements } : null,
            capturedAt: new Date().toISOString(),
            source: location.hostname,
        };
    }

    // ── JSON export (完整原始数据) ──────────────────────────────

    function downloadJSON(filename, data) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
    }

    function exportJsonData() {
        // 采集到的成员：自己与公会成员一视同仁 —— 全部来自本次采集结果，不做特殊处理、不偏好缓存。
        const members = [];
        for (const [, cached] of state.cachedProfiles) {
            if (cached.profile) members.push(cached.profile);
        }

        // 兜底：一个成员 profile 都没采到时（例如没进公会成员页），用实时 WS 抓到的自己角色数据，
        // 保留「只导出自己」的用法。这不参与正常采集流程。
        if (members.length === 0) {
            const payload = buildPayload();
            if (payload) {
                const rebuilt = {
                    sharableCharacter: {
                        name: payload.character.name,
                        gameMode: payload.character.gameMode,
                    },
                    characterSkills: Object.entries(payload.skills).map(([k, v]) => ({
                        skillHrid: '/skills/' + k,
                        level: v,
                    })),
                    wearableItemMap: payload.equipment.reduce((m, eq) => {
                        m['/item_locations/' + eq.slot] = {
                            itemHrid: eq.itemHrid,
                            enhancementLevel: eq.enhancementLevel,
                        };
                        return m;
                    }, {}),
                    _source: 'self',
                    _capturedAt: payload.capturedAt,
                };
                const myBuffLevels = state.guildBuffLevelMap && Object.keys(state.guildBuffLevelMap).length
                    ? { ...state.guildBuffLevelMap } : null;
                if (myBuffLevels) rebuilt.guildBuffLevelMap = myBuffLevels;
                // 成就信息也归属个人数据（实时抓到的成就全表）
                if (payload.achievements) rebuilt.achievements = payload.achievements;
                members.push(rebuilt);
            }
        }

        if (members.length === 0) {
            btnState.phase = 'error';
            renderStatus();
            alert('尚未采集到任何成员数据。\n\n请进入「公会 - 成员」列表页，点「开始采集公会成员」；采完后会自动导出 JSON。');
            return;
        }

        // 公会建筑等级是公会全局数据，挂到第一位成员上供计算器导入时自动预填
        const gwBuildings = state.guildBuildingLevelMap && Object.keys(state.guildBuildingLevelMap).length
            ? { ...state.guildBuildingLevelMap } : null;
        if (gwBuildings) members[0] = { ...members[0], _guildBuildingLevelMap: gwBuildings };

        const dateStr = new Date().toISOString().slice(0, 10);
        const filename = `MWI_公会_${members.length}人_${dateStr}.json`;
        downloadJSON(filename, members);
        btnState.phase = 'done';
        btnState.count = members.length;
        renderStatus();
    }

    GM_registerMenuCommand('导出 JSON（当前已采集数据）', exportJsonData);

    // ── 自动遍历公会成员（免手动逐个点击）─────────────────────────

    const AUTO_PROFILE_TIMEOUT_MS = 10000;
    // 每一步操作之间统一的随机延迟区间（毫秒）。当前流程是：
    // 输入指令 → 等 → 点击发送 → 等 profile_shared → 等 → 关闭资料页 → 等 → 下一个。
    // 每个 "等" 都用 randInt(STEP_DELAY_MIN_MS, STEP_DELAY_MAX_MS)。
    const STEP_DELAY_MIN_MS = 500;
    const STEP_DELAY_MAX_MS = 1000;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const stepDelay = () => sleep(randInt(STEP_DELAY_MIN_MS, STEP_DELAY_MAX_MS));
    let autoClickRunning = false;

    function waitForProfileCaptured(prevCount) {
        return new Promise((resolve) => {
            const start = Date.now();
            const check = setInterval(() => {
                if ((state.captures || 0) > prevCount) {
                    clearInterval(check);
                    resolve(true);
                } else if (Date.now() - start > AUTO_PROFILE_TIMEOUT_MS) {
                    clearInterval(check);
                    resolve(false);
                }
            }, 150);
        });
    }

    function findChatInput() {
        return document.querySelector('[class*="Chat_chatInputContainer"] input')
            || document.querySelector('[class*="chatInputContainer"] input')
            || document.querySelector('form input[type="text"]');
    }

    // MWI 的发送按钮是 <button class="Button_button__..."]>发送</button>，
    // 既没有 type 也没有 aria-label，所以最稳的匹配是"文本是 发送/Send"。
    function isSendButton(btn) {
        if (!btn || btn.disabled) return false;
        const text = (btn.textContent || '').trim();
        return text === '发送' || text === '发 送' || /^send$/i.test(text);
    }

    function findChatSendButton(chatInput) {
        // 1) 聊天输入框所在 form 里，按文本挑发送按钮
        const form = chatInput?.closest('form');
        if (form) {
            for (const btn of form.querySelectorAll('button')) {
                if (isSendButton(btn)) return btn;
            }
            // form 内确实存在但都不匹配"发送"文本，退回 submit 按钮
            const submit = form.querySelector('button[type="submit"]:not([disabled])');
            if (submit) return submit;
        }
        // 2) 聊天输入容器附近，按文本挑发送按钮
        const containers = document.querySelectorAll(
            '[class*="Chat_chatInputContainer"], [class*="chatInputContainer"], [class*="Chat_chat"], [class*="ChatPanel"]'
        );
        for (const container of containers) {
            for (const btn of container.querySelectorAll('button')) {
                if (isSendButton(btn)) return btn;
            }
        }
        // 3) 全页面兜底：找所有文本为"发送"的按钮里，位置离聊天框最近的一颗
        if (chatInput) {
            const inputRect = chatInput.getBoundingClientRect();
            const candidates = Array.from(document.querySelectorAll('button')).filter(isSendButton);
            let best = null, bestDist = Infinity;
            for (const btn of candidates) {
                const r = btn.getBoundingClientRect();
                const dx = r.left + r.width / 2 - (inputRect.left + inputRect.width / 2);
                const dy = r.top + r.height / 2 - (inputRect.top + inputRect.height / 2);
                const dist = dx * dx + dy * dy;
                if (dist < bestDist) { bestDist = dist; best = btn; }
            }
            if (best) return best;
        }
        return null;
    }

    // 读取 React 挂在 DOM 上的合成事件 handler（React 15~19 都行）
    function getReactHandler(el, name) {
        if (!el) return null;
        for (const key of Object.keys(el)) {
            if (key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$')) {
                const props = el[key];
                if (props && typeof props[name] === 'function') return props[name];
            }
        }
        return null;
    }

    // 让 React 感知受控 input 的值变化。React 会用 `_valueTracker` 缓存上一次的
    // value 做 diff，只有 tracker.currentValue !== input.value 时才会跑 onChange。
    // 直接 nativeSetter + dispatch('input') 有时会被 tracker 判定"没变化"而吞掉，
    // 所以这里在写完新值之后手动把 tracker 回滚到旧值，强制 React 认为值变了。
    function setReactInputValue(input, value) {
        const proto = window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        const oldValue = input.value;
        nativeSetter.call(input, value);
        if (input._valueTracker && oldValue !== value) {
            input._valueTracker.setValue(oldValue);
        }
        input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }

    // 直接调 chatInput 上 React fiber 挂着的 onChange/onInput handler。
    // 用来兜底 execCommand/nativeSetter 都没让 React state 同步的情况：
    // 只要能调到 onChange，React 里就会执行 setState(e.target.value)，
    // 从此 send button 里读到的 state 就是我们写入的最新 text。
    function syncReactInputState(input, value) {
        const buildEvent = (type) => ({
            type,
            target: input,
            currentTarget: input,
            preventDefault: () => {},
            stopPropagation: () => {},
            isDefaultPrevented: () => false,
            isPropagationStopped: () => false,
            persist: () => {},
            nativeEvent: type === 'input'
                ? new InputEvent('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' })
                : new Event(type, { bubbles: true, cancelable: true }),
        });
        const onChange = getReactHandler(input, 'onChange');
        if (typeof onChange === 'function') {
            try { onChange(buildEvent('change')); } catch (err) {
                console.warn('[MWI Export] fiber onChange 调用失败:', err);
            }
        }
        const onInput = getReactHandler(input, 'onInput');
        if (typeof onInput === 'function' && onInput !== onChange) {
            try { onInput(buildEvent('input')); } catch (err) {
                console.warn('[MWI Export] fiber onInput 调用失败:', err);
            }
        }
    }

    // 只把指令写进聊天框，不点发送。用来搭配随后的 stepDelay + submitChat。
    // 优先走 execCommand('insertText')：它派发的是浏览器合成的可信 InputEvent，
    // React 的受控 input 会走完整 onChange/setState 流程；nativeSetter+tracker
    // hack 只是兜底，覆盖 execCommand 被浏览器移除后的场景。
    // 最后再显式调一次 fiber onChange，保证 React state 一定跟 DOM 同步。
    function typeChatCommand(text) {
        const chatInput = findChatInput();
        if (!chatInput) {
            console.error('[MWI Export] 未找到聊天输入框');
            return false;
        }

        try { chatInput.focus(); } catch (_) { /* noop */ }

        let filled = false;
        try {
            // 先选中所有已有内容，让 insertText 走"替换"路径而不是"追加"
            if (typeof chatInput.setSelectionRange === 'function') {
                chatInput.setSelectionRange(0, chatInput.value.length);
            } else if (typeof chatInput.select === 'function') {
                chatInput.select();
            }
            if (document.execCommand && document.execCommand('insertText', false, text)) {
                if (chatInput.value === text) filled = true;
            }
        } catch (err) {
            console.warn('[MWI Export] execCommand insertText 失败，回退 nativeSetter:', err);
        }
        if (!filled) setReactInputValue(chatInput, text);

        // 关键：强制让 React state 同步到 text，防止 send button 读到空 state 白点
        syncReactInputState(chatInput, text);
        return true;
    }

    // 点击"发送"按钮（找不到就走 form.requestSubmit()，再兜底合成 Enter 键）。
    // 提交前会再校验一次 DOM value，若被外部逻辑清空则重新写入 lastText。
    function submitChat(lastText) {
        console.log('[MWI Export] >>> submitChat entry', lastText);
        const chatInput = findChatInput();
        if (!chatInput) {
            console.error('[MWI Export] 未找到聊天输入框');
            return false;
        }
        if (typeof lastText === 'string' && chatInput.value !== lastText) {
            // 值被外部改掉了，重新走 execCommand 补一次（保持 React state 同步）
            typeChatCommand(lastText);
        }

        let sendBtn = null;
        try {
            sendBtn = findChatSendButton(chatInput);
        } catch (err) {
            console.error('[MWI Export] findChatSendButton 抛异常:', err);
        }
        // 优先从 chatInput 找 form，其次从按钮找（防止两者不在同一 form 里）
        const form = chatInput.closest('form') || sendBtn?.closest('form') || null;
        // 探测按钮/表单/输入框上的框架挂点（React/Preact/Solid/Svelte/Vue）
        const listSpecialKeys = (el) => el ? Object.keys(el).filter(k => k.startsWith('_') || k.startsWith('$')) : [];
        console.log('[MWI Export] submitChat', {
            domValue: chatInput.value,
            expected: lastText,
            hasBtn: !!sendBtn,
            btnDisabled: sendBtn?.disabled,
            btnText: (sendBtn?.textContent || '').trim(),
            btnClass: sendBtn?.className,
            btnType: sendBtn?.getAttribute('type'),
            hasForm: !!form,
            hasReactOnClick: !!getReactHandler(sendBtn, 'onClick'),
            hasReactOnSubmit: !!getReactHandler(form, 'onSubmit'),
            hasReactOnChange: !!getReactHandler(chatInput, 'onChange'),
            btnKeys: listSpecialKeys(sendBtn),
            formKeys: listSpecialKeys(form),
            inputKeys: listSpecialKeys(chatInput),
        });

        // MWI 上三个 React handler 都是 false，意味着发送逻辑走的是原生
        // addEventListener（可能挂在 form.submit / button.click / input.keydown 任一位置）。
        // 索性把三条通道全部触发一次，成功一种即达成目的：
        //   A) form.requestSubmit(sendBtn) 派发 trusted submit 事件
        //   B) sendBtn.click() + pointer/mouse 序列 触发原生 click 监听
        //   C) chatInput 上合成 Enter 键 触发键盘监听
        let anyPathFired = false;

        // A) form.requestSubmit —— trusted 事件，最规范的模拟点击 submit 按钮
        if (form && typeof form.requestSubmit === 'function') {
            try {
                if (sendBtn && !sendBtn.disabled) form.requestSubmit(sendBtn);
                else form.requestSubmit();
                anyPathFired = true;
                console.log('[MWI Export] submitChat A) requestSubmit 已派发');
            } catch (err) {
                console.warn('[MWI Export] form.requestSubmit 失败:', err);
            }
        }

        // B) 直接点击发送按钮 + pointer/mouse 序列 + fiber onClick 兜底
        if (sendBtn && !sendBtn.disabled) {
            try {
                const rect = sendBtn.getBoundingClientRect();
                const evOpts = {
                    bubbles: true, cancelable: true, view: window,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2,
                    button: 0,
                };
                try {
                    sendBtn.dispatchEvent(new PointerEvent('pointerdown', evOpts));
                    sendBtn.dispatchEvent(new MouseEvent('mousedown', evOpts));
                    sendBtn.dispatchEvent(new PointerEvent('pointerup', evOpts));
                    sendBtn.dispatchEvent(new MouseEvent('mouseup', evOpts));
                } catch (_) { /* 老浏览器可能不支持 PointerEvent */ }
                sendBtn.click();
                const onClick = getReactHandler(sendBtn, 'onClick');
                if (typeof onClick === 'function') {
                    try {
                        onClick({
                            type: 'click', target: sendBtn, currentTarget: sendBtn,
                            preventDefault: () => {}, stopPropagation: () => {},
                            nativeEvent: new MouseEvent('click', evOpts),
                        });
                    } catch (err) {
                        console.warn('[MWI Export] fiber onClick 调用失败:', err);
                    }
                }
                anyPathFired = true;
                console.log('[MWI Export] submitChat B) button 事件序列已派发');
            } catch (err) {
                console.warn('[MWI Export] 按钮点击失败:', err);
            }
        }

        // C) 合成 Enter 键 —— 覆盖只监听 keydown 的实现
        try {
            const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            chatInput.focus();
            chatInput.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
            chatInput.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
            chatInput.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
            anyPathFired = true;
            console.log('[MWI Export] submitChat C) Enter 键已派发');
        } catch (err) {
            console.warn('[MWI Export] Enter 键派发失败:', err);
        }

        return anyPathFired;
    }

    // 关闭 /profile 命令弹出的角色资料对话框（找不到关闭按钮时兜底发 ESC）
    function closeProfileDialog() {
        const dialogs = document.querySelectorAll(
            '[role="dialog"], [class*="Modal_modal" i], [class*="Modal_modalContainer" i], [class*="Dialog_" i]'
        );
        let clicked = false;
        for (const dlg of dialogs) {
            const style = window.getComputedStyle(dlg);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            let closeBtn = dlg.querySelector('[class*="closeIcon" i]')
                || dlg.querySelector('[class*="closeButton" i]')
                || dlg.querySelector('button[aria-label*="lose" i]')
                || dlg.querySelector('button[aria-label*="关" i]');
            if (!closeBtn) {
                const closeSvg = dlg.querySelector('svg[class*="close" i]');
                if (closeSvg) closeBtn = closeSvg.closest('button') || closeSvg.parentElement;
            }
            if (closeBtn) {
                try {
                    closeBtn.click();
                    clicked = true;
                } catch (err) {
                    console.warn('[MWI Export] 关闭对话框失败:', err);
                }
            }
        }
        if (clicked) return true;

        // 兜底：合成 ESC 键，让顶层 Modal 自行关闭
        const escOpts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
        const target = document.activeElement && document.activeElement !== document.body
            ? document.activeElement
            : document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', escOpts));
        target.dispatchEvent(new KeyboardEvent('keyup', escOpts));
        return false;
    }

    async function autoClickMembers(opts = {}) {
        const { force = false } = opts;
        if (autoClickRunning) {
            console.warn('[MWI Export] 自动采集已在运行中');
            return;
        }

        // 从公会成员表格提取成员名
        const memberNames = [];
        const rows = document.querySelectorAll('[class*="GuildPanel_membersTable"] tbody tr');
        for (const row of rows) {
            const nameTd = row.querySelector('[class*="name" i]') || row.querySelector('td');
            if (!nameTd) continue;
            const nameSpan = nameTd.querySelector('[data-name]');
            let name = '';
            if (nameSpan) {
                name = nameSpan.getAttribute('data-name') || (nameSpan.textContent || '').trim();
            } else {
                const spans = nameTd.querySelectorAll('span');
                for (const s of spans) {
                    const t = (s.textContent || '').trim();
                    if (t && t.length > 0 && t.length < 30) { name = t; break; }
                }
                if (!name) name = (nameTd.textContent || '').trim().split(/\s+/)[0] || '';
            }
            if (name) memberNames.push(name);
        }

        console.log(`[MWI Export] 提取到 ${memberNames.length} 个成员名:`, memberNames);
        if (memberNames.length === 0) {
            console.warn('[MWI Export] 未提取到成员名字');
            if (force) {
                btnState.phase = 'error'; renderStatus();
                alert('[MWI Export] 未提取到成员名字。请确认已打开公会成员列表页面。');
            }
            return;
        }

        const chatInput = document.querySelector('[class*="Chat_chatInputContainer"] input')
            || document.querySelector('[class*="chatInputContainer"] input')
            || document.querySelector('form input[type="text"]');
        if (!chatInput) {
            console.warn('[MWI Export] 未找到聊天输入框');
            if (force) {
                btnState.phase = 'error'; renderStatus();
                alert('[MWI Export] 未找到聊天输入框。请确认聊天面板已打开。');
            }
            return;
        }

        autoClickRunning = true;
        let sent = 0;
        let captured = 0;
        const totalCount = memberNames.length;

        // 走 WebSocket 直发 view_profile 指令，完全绕开 UI 的 isTrusted 校验。
        const wsReady = state.mwiSocket?.readyState === 1;
        if (!wsReady) {
            const msg = '[MWI Export] 尚未连接到 MWI WebSocket，请等游戏加载完成再试。';
            if (force) alert(msg); else console.warn(msg);
            btnState.phase = 'error'; renderStatus();
            autoClickRunning = false;
            return;
        }

        console.log('[MWI Export] 使用 WebSocket 直发 view_profile 模式');
        btnState.phase = 'running'; btnState.sent = 0; btnState.total = totalCount;
        renderStatus();

        for (const name of memberNames) {
            // 不做任何特殊处理：自己也在成员表里，一并重新采集；
            // 已缓存过的成员也重新抓取（覆盖旧数据），判断“又采到一个”用 captures 计数而非 Map.size。

            // 1) 通过 WebSocket 直发 view_profile 消息
            const prevSize = state.captures || 0;
            const ok = sendViewProfileByWebSocket(name);
            if (!ok) {
                console.error('[MWI Export] WebSocket 发送失败，中止');
                break;
            }
            sent++;
            btnState.sent = sent;
            renderStatus();
            console.log(`[MWI Export] (${sent}/${totalCount}) view_profile ${name}`);

            // 2) 等 profile_shared 到达
            const success = await waitForProfileCaptured(prevSize);
            if (success) {
                captured++;
                console.log(`[MWI Export]   ✓ ${name}`);
            } else {
                console.warn(`[MWI Export]   ✗ 超时: ${name}`);
            }

            // 3) 等 0.5-1s，让游戏弹出的资料对话框完成渲染
            await stepDelay();

            // 4) 关闭资料对话框
            closeProfileDialog();

            // 5) 等 0.5-1s，再进入下一个成员
            await stepDelay();
        }

        autoClickRunning = false;
        const total = state.cachedProfiles.size;
        console.log(`[MWI Export] 完成！发送 ${sent}，成功 ${captured}，总计 ${total} 人`);
        btnState.count = captured;
        btnState.phase = captured > 0 ? 'done' : 'error';
        renderStatus();
        if (captured > 0) {
            // 采集完成 → 自动导出，不需要再单独点「导出」
            console.log('[MWI Export] 采集完成，自动导出 JSON');
            exportJsonData();
        } else if (force) {
            alert('自动采集失败：没有捕获到任何成员数据，请稍后重试。');
        }
    }

    GM_registerMenuCommand('采集公会成员并保存 JSON', () => autoClickMembers({ force: true }));

    hookWebSocketMessages();
    hookWebSocketSend();

    function boot() {
        addStatusButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
