/**
 * HA-STORE.JS — Firebase Realtime Database 버전 (유저 사이트 전용)
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref, set, get, push, update, remove }
  from "https://www.gstatic.com/firebasejs/10.10.0/firebase-database.js";
// ── Firebase 초기화 ──────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAF-Rn7tzIjQeyUDJKnvKTRNccsXUVsIjo",
  authDomain: "higherad-b9d62.firebaseapp.com",
  databaseURL: "https://higherad-b9d62-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "higherad-b9d62",
  storageBucket: "higherad-b9d62.firebasestorage.app",
  messagingSenderId: "938928195180",
  appId: "1:938928195180:web:8209b1e02a8caabe643a49",
  measurementId: "G-01T4L4ZGVV"
};

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);

// ── 텔레그램 알림 설정 ────────────────────────────────────────
const TELEGRAM = {
  token:   '8696324609:AAFo10CLRJiWdDahGtCqHfLKY16HsHZOnE8',
  chatIds: [
    '-1003641342076',   // 관리자1
    // '여기에추가',   // 관리자2
    // '여기에추가',   // 관리자3
  ],
};

// ── DB 경로 상수 ─────────────────────────────────────────────
const PATHS = {
  slots:           'ha/slots',
  users:           'ha/users',
  notices:         'ha/notices',
  paid:            'ha/paid_slots',
  refunds:         'ha/refunds',
  settleSnapshots: 'ha/settle_snapshots',
};

async function sendTelegram(message) {
  try {
    await Promise.all(
      TELEGRAM.chatIds.map(chatId =>
        fetch(`https://api.telegram.org/bot${TELEGRAM.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
          }),
        })
      )
    );
  } catch (e) {
    console.warn('텔레그램 알림 실패:', e);
  }
}

// ── 유틸: Firebase 스냅샷 → 배열 변환 ───────────────────────
function snapToArray(snapshot) {
  if (!snapshot.exists()) return [];
  const val = snapshot.val();
  return Object.entries(val).map(([key, data]) => ({ ...data, _key: key }));
}

// ── 내부 이벤트 버스 ─────────────────────────────────────────
function dispatch(event) {
  window.dispatchEvent(new CustomEvent(event));
}

// ════════════════════════════════════════════════════════════
const HA = {

  // ── 현재 로그인 유저 ───────────────────────────────────────
  getCurrentUser() {
    return JSON.parse(sessionStorage.getItem('ha_current_user') || 'null');
  },

  // ── 로그인 ────────────────────────────────────────────────
  async login(username, password) {
    // 일반 회원 — Firebase에서 조회
    try {
      const snapshot = await get(ref(db, PATHS.users));
      const users = snapToArray(snapshot);
      const found = users.find(u => u.username === username && u.password === password);
      if (found) {
        // 승인 대기 중인 계정 로그인 차단
        if (found.approved === false) {
          return { ok: false, reason: 'pending' };
        }
        const user = { ...found };
        sessionStorage.setItem('ha_current_user', JSON.stringify(user));
        return { ok: true, user };
      }
      return { ok: false };
    } catch (e) {
      console.error('login error', e);
      return { ok: false };
    }
  },

  logout() {
    sessionStorage.removeItem('ha_current_user');
  },

  // ════════════════════════════════════════════════════════
  // 캠페인 CRUD
  // ════════════════════════════════════════════════════════

  async getSlots() {
    const snapshot = await get(ref(db, PATHS.slots));
    return snapToArray(snapshot).sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );
  },

  async addSlot(data) {
    // 접수 시점 단가 스냅샷: userId로 현재 단가 조회 후 슬롯에 저장
    let unitPriceSnapshot = 0;
    try {
      const uSnap = await get(ref(db, PATHS.users));
      const users = snapToArray(uSnap);
      const u = users.find(u => u.username === (data.userId || ''));
      unitPriceSnapshot = u ? (u.unitPrice || 0) : 0;
    } catch(e) {}

    const newSlot = {
      status:        'pending',
      createdAt:     new Date().toISOString(),
      agencyId:      data.agencyId      || '',
      userId:        data.userId        || '',
      slotType:      data.slotType      || '',
      startDate:     data.startDate     || '',
      endDate:       data.endDate       || '',
      storeName:     data.storeName     || '',
      rankKeyword:   data.rankKeyword   || '',
      url:           data.url           || '',
      mid:           data.mid           || '',
      workKeyword:   data.workKeyword   || '',
      memo:          data.memo          || '',
      days:          Number(data.days)        || 0,
      dailyTarget:   Number(data.dailyTarget) || 0,
      unitPrice:     unitPriceSnapshot,
      rank:          null,
      inflow:        0,
    };
    const newRef = await push(ref(db, PATHS.slots), newSlot);
    const result = { ...newSlot, _key: newRef.key };
    dispatch('ha:slots:updated');
    return result;
  },

  // ── 개별접수 텔레그램 알림 ───────────────────────────────
  async notifySingle(slot) {
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    // 슬롯 저장 단가 우선, 없으면 유저 DB 조회
    let unitPrice = (slot.unitPrice != null && slot.unitPrice > 0) ? slot.unitPrice : 0;
    if (!unitPrice) {
      try {
        const uSnap = await get(ref(db, PATHS.users));
        const users = snapToArray(uSnap);
        const u = users.find(u => u.username === slot.userId);
        unitPrice = u ? (u.unitPrice || 0) : 0;
      } catch(e) {}
    }
    const totalTarget = (slot.dailyTarget || 0) * (slot.days || 0);
    const amount      = totalTarget * unitPrice;
    const amountVat   = Math.round(amount * 1.1);
    await sendTelegram(
`📥 <b>새 캠페인 접수 (개별)</b>
━━━━━━━━━━━━━━━━
• 대행사: ${slot.agencyId}
• 캠페인 수: 1건
• 전체 목표: ${totalTarget.toLocaleString()}개
• 단가: ${unitPrice.toLocaleString()}원
• 금액: ${amount.toLocaleString()}원(VAT 별도)
• 입금액: ${amountVat.toLocaleString()}원 (VAT 포함)
⏰ 접수시간: ${now}
━━━━━━━━━━━━━━━━
👉 <a href="https://higherad.kro.kr/">어드민에서 확인하세요</a>`
    );
  },

  // ── 엑셀 일괄접수 텔레그램 알림 ─────────────────────────
  async notifyExcelBatch(slots) {
    if (!slots.length) return;
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    // 슬롯별 저장 단가 우선 사용
    const agencyId    = slots[0].agencyId || '-';
    const totalTarget = slots.reduce((sum, s) => sum + (s.dailyTarget || 0) * (s.days || 0), 0);
    const amount      = slots.reduce((sum, s) => {
      const p = (s.unitPrice != null && s.unitPrice > 0) ? s.unitPrice : 0;
      return sum + (s.dailyTarget || 0) * (s.days || 0) * p;
    }, 0);
    const unitPrice   = slots[0].unitPrice || 0; // 표시용
    const amountVat   = Math.round(amount * 1.1);

    await sendTelegram(
`📊 <b>새 캠페인 접수 (엑셀)</b>
━━━━━━━━━━━━━━━━
• 대행사: ${agencyId}
• 캠페인 수: ${slots.length}건
• 전체 목표: ${totalTarget.toLocaleString()}개
• 단가: ${unitPrice.toLocaleString()}원
• 금액: ${amount.toLocaleString()}원(VAT 별도)
• 입금액: ${amountVat.toLocaleString()}원 (VAT 포함)
⏰ 접수시간: ${now}
━━━━━━━━━━━━━━━━
👉 <a href="https://higherad.kro.kr/">어드민에서 확인하세요</a>`
    );
  },

  // ════════════════════════════════════════════════════════
  // 회원 CRUD
  // ════════════════════════════════════════════════════════

  async getUsers() {
    const snapshot = await get(ref(db, PATHS.users));
    return snapToArray(snapshot);
  },

  async addUser(data) {
    const agencyName = data.agency || '';
    const newUser = {
      username:   data.username   || '',
      password:   data.password   || '',
      agency:     agencyName,       // 회원 테이블의 업체명
      agencyId:   agencyName,       // 캠페인에서 참조하는 대행사 ID와 동일한 값
      role:       'member',
      unitPrice:  Number(data.unitPrice) || 0,
      memo:       data.memo       || '',
      createdAt:  new Date().toISOString().slice(0, 10),
      approved:   data.approved !== undefined ? data.approved : false,
    };
    const newRef = await push(ref(db, PATHS.users), newUser);
    dispatch('ha:users:updated');
    return { ...newUser, _key: newRef.key };
  },

  async updateUser(key, patch) {
    await update(ref(db, `${PATHS.users}/${key}`), patch);
    dispatch('ha:users:updated');
  },

  // ════════════════════════════════════════════════════════
  // 공지사항
  // ════════════════════════════════════════════════════════

  async getNotices() {
    const snapshot = await get(ref(db, PATHS.notices));
    if (!snapshot.exists()) return [];
    return snapToArray(snapshot).sort((a, b) =>
      new Date(b.date) - new Date(a.date)
    );
  },

  async updateNotice(key, patch) {
    await update(ref(db, `${PATHS.notices}/${key}`), patch);
  },

  // ════════════════════════════════════════════════════════
  // 정산 상태
  // ════════════════════════════════════════════════════════

  async getPaidSet() {
    const snapshot = await get(ref(db, PATHS.paid));
    if (!snapshot.exists()) return new Set();
    return new Set(Object.keys(snapshot.val()));
  },

  // ════════════════════════════════════════════════════════
  // 환불 관리
  // ════════════════════════════════════════════════════════

  async getRefunds() {
    const snapshot = await get(ref(db, PATHS.refunds));
    if (!snapshot.exists()) return {};
    return snapshot.val();
  },

  // ════════════════════════════════════════════════════════
  // 정산 스냅샷
  // ════════════════════════════════════════════════════════

  async saveSettleSnapshot(snapKey, data, force = false) {
    const path = `${PATHS.settleSnapshots}/${snapKey}`;
    if (!force) {
      const existing = await get(ref(db, path));
      if (existing.exists()) return;
    }
    await set(ref(db, path), { ...data, savedAt: new Date().toISOString() });
  },

  async getAllSettleSnapshots() {
    const snap = await get(ref(db, PATHS.settleSnapshots));
    if (!snap.exists()) return {};
    const result = {};
    snap.forEach(node => {
      const key  = node.key;
      const data = node.val();
      if (!result[key] || (data.confirmedAt && data.confirmedAt > (result[key].confirmedAt||''))) {
        result[key] = data;
      }
    });
    return result;
  },

};

// 전역 노출
window.HA = HA;

export default HA;
