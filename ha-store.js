/**
 * HA-STORE.JS — Firebase Realtime Database 버전 (유저 사이트 전용)
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref,
  set as _set, get as _get, push as _push, update as _update, remove as _remove }
  from "https://www.gstatic.com/firebasejs/10.10.0/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, updatePassword }
  from "https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js";

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
const auth = getAuth(app);

// ── 인증 상태 복원 대기 래퍼 ─────────────────────────────────
// RTDB 규칙(auth != null)으로 인해 새로고침 직후 세션 복원 전에
// get이 먼저 실행되면 permission denied가 발생할 수 있음.
const authReady = auth.authStateReady();

async function get(r)        { await authReady; return _get(r); }
async function set(r, v)     { await authReady; return _set(r, v); }
async function push(r, v)    { await authReady; return _push(r, v); }
async function update(r, v)  { await authReady; return _update(r, v); }
async function remove(r)     { await authReady; return _remove(r); }

// ── Cloud Run 엔드포인트 ─────────────────────────────────────
const CLOUD_RUN = 'https://higherad-auto-938928195180.asia-northeast3.run.app';

// ── DB 경로 상수 ─────────────────────────────────────────────
const PATHS = {
  slots:           'ha/slots',
  users:           'ha/users',
  notices:         'ha/notices',
  paid:            'ha/paid_slots',
  refunds:         'ha/refunds',
  settleSnapshots: 'ha/settle_snapshots',
};

// higher_user 포털 전용 Cloud Run 프록시 호출 — userId/agencyId/unitPrice 등 신원 관련 값은
// 클라이언트가 보낸 값을 신뢰하지 않고 서버가 ID 토큰으로 검증해 직접 결정한다.
// (과거 버전은 ha/slots·ha/users 전체 노드를 클라이언트에서 직접 읽어 userId 위조 및 전체
//  고객 데이터(평문 비밀번호 포함) 노출이 가능했음 — project_higher_user_auth_gap.md 참조)
async function callUserApi(path, body) {
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) throw new Error('로그인이 필요합니다.');
  const idToken = await user.getIdToken();
  const res = await fetch(`${CLOUD_RUN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${path} 요청 실패`);
  return json;
}

async function sendTelegram(message) {
  try {
    await callUserApi('/notify', { message });
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
  if (event === 'ha:slots:updated') _slotsCache = null; // 쓰기 이후엔 캐시 무효화
  window.dispatchEvent(new CustomEvent(event));
}

// ── getSlots() 캐시 ──────────────────────────────────────────
// /user-slots가 매 호출마다 서버에서 ha/slots(6MB+) 전체를 읽어 필터링해서 돌려주는데,
// 탭 전환·필터 변경·페이지네이션 클릭마다 캐싱 없이 새로 불려서 RTDB 트래픽이 불필요하게
// 쌓였음 — 세션당 1회만 실제 호출하고 이후엔 캐시 재사용, 쓰기(addSlot/updateSlot) 후에는
// 위 dispatch()가 자동으로 무효화한다(2026-08-11).
let _slotsCache = null;

// ════════════════════════════════════════════════════════════
const HA = {

  // ── 현재 로그인 유저 ───────────────────────────────────────
  getCurrentUser() {
    return JSON.parse(sessionStorage.getItem('ha_current_user') || 'null');
  },

  // ── 로그인 ────────────────────────────────────────────────
  async login(username, password) {
    const email = `${username}@higherad.app`;
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      // 프로필은 서버(/user-profile)에서 본인 것만 받아옴 — ha/users 전체 노드를 클라이언트가
      // 직접 읽지 않음(비밀번호 필드 포함 전체 고객 데이터 노출 방지)
      const { user: profile } = await callUserApi('/user-profile');
      if (profile.approved === false) {
        await signOut(auth);
        return { ok: false, reason: 'pending' };
      }
      const user = { ...profile, id: cred.user.uid };
      sessionStorage.setItem('ha_current_user', JSON.stringify(user));
      return { ok: true, user };
    } catch (e) {
      await signOut(auth).catch(() => {});
      return { ok: false };
    }
  },

  logout() {
    sessionStorage.removeItem('ha_current_user');
    signOut(auth).catch(() => {});
  },

  // ════════════════════════════════════════════════════════
  // 캠페인 CRUD
  // ════════════════════════════════════════════════════════

  // 본인(userId=로그인 username) 캠페인만 서버가 필터링해 반환 — 다른 대행사 데이터는 안 옴.
  // 세션 캐시(_slotsCache) 재사용 — 동시에 여러 곳에서 부르면 진행 중인 요청 하나를 공유한다.
  async getSlots() {
    if (!_slotsCache) {
      _slotsCache = callUserApi('/user-slots').then(({ slots }) =>
        slots.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      ).catch(err => { _slotsCache = null; throw err; });
    }
    return _slotsCache;
  },

  // 접수: userId/agencyId/unitPrice는 서버가 검증된 로그인 신원(super면 targetUsername) 기준으로
  // 직접 결정 — 클라이언트가 보낸 값은 무시됨(이전엔 그대로 신뢰해 타 대행사 명의 위조 접수 가능했음).
  async addSlot(data) {
    const result = await callUserApi('/user-add-slot', {
      targetUsername: data.userId || undefined, // super 전용, member면 서버가 무시
      startDate:      data.startDate     || '',
      endDate:        data.endDate       || '',
      storeName:      data.storeName     || '',
      rankKeyword:    data.rankKeyword   || '',
      url:            data.url           || '',
      mid:            data.mid           || '',
      memo:           data.memo          || '',
      days:           Number(data.days)        || 0,
      dailyTarget:    Number(data.dailyTarget) || 0,
    });
    dispatch('ha:slots:updated');
    return result;
  },

  async updateSlot(key, patch) {
    await update(ref(db, `${PATHS.slots}/${key}`), patch);
    dispatch('ha:slots:updated');
  },

  // ── 개별접수 텔레그램 알림 ───────────────────────────────
  async notifySingle(slot) {
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    // 단가는 /user-add-slot 응답에 서버가 항상 채워서 옴(0원도 유효값이므로 재조회 폴백 불필요)
    const unitPrice = slot.unitPrice || 0;
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

  // 본인 프로필만(비밀번호 제외) — 대시보드 단가 조회 등에 사용.
  async getMyProfile() {
    const { user } = await callUserApi('/user-profile');
    return user;
  },

  // super 전용 — 대리접수 대상 영업점 목록(회원만, 비밀번호 등 민감정보 제외).
  async getBranchList() {
    const { branches } = await callUserApi('/user-branch-list');
    return branches;
  },

  async addUser(data) {
    const agencyName = data.agency || '';
    const username   = data.username || '';
    const password   = data.password || '';

    // Firebase Auth 자가 회원가입
    const email = `${username}@higherad.app`;
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (e) {
      if (e.code === 'auth/email-already-in-use') {
        throw new Error('이미 사용 중인 아이디입니다.');
      }
      throw e;
    }

    // RTDB 프로필 저장 (password 제외)
    const newUser = {
      username,
      agency:    agencyName,
      agencyId:  agencyName,
      role:      'member',
      unitPrice: Number(data.unitPrice) || 0,
      memo:      data.memo || '',
      createdAt: new Date().toISOString().slice(0, 10),
      approved:  data.approved !== undefined ? data.approved : false,
    };
    const newRef = await push(ref(db, PATHS.users), newUser);
    await signOut(auth); // 가입 후 자동 로그인 방지 (관리자 승인 대기)
    dispatch('ha:users:updated');
    return { ...newUser, _key: newRef.key };
  },

  async updateUser(key, patch) {
    if (patch.password) {
      await updatePassword(auth.currentUser, patch.password);
      const { password: _, ...rtdbPatch } = patch;
      await update(ref(db, `${PATHS.users}/${key}`), rtdbPatch);
    } else {
      await update(ref(db, `${PATHS.users}/${key}`), patch);
    }
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
