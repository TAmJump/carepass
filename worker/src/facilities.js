// 施設関連 API ヘルパー
//
// 仕様 (HANDOVER v10.1 §6-2-3 / §6-6-3 / §11-3):
//   ・facilities テーブル拡張 (name_kana / prefecture / category / report_base_url 等) を活用
//   ・月次活動報告は施設の自社サイトに置く。CSP は URL リンクだけ管理
//   ・URL は完全統一フォーマット {report_base_url}/{YYYY-MM}.html

import { uuid } from './db.js';

// =====================================================================
// 公開: 施設ディレクトリ検索
// =====================================================================
//   query:
//     q          — 名前/ふりがな 部分一致 (大文字小文字無視)
//     prefecture — 都道府県完全一致
//     category   — カテゴリ完全一致
//     accepting  — '1' なら accepting=1 のみ
//     cursor     — 前回最後の created_at (ISO)
//     limit      — 1-50 (default 24)
//
//   各施設には最新公開済の月次報告書URLも含めて返す。
export async function searchFacilitiesDirectory(env, query) {
  const limit = Math.max(1, Math.min(50, parseInt(query.limit, 10) || 24));
  const q          = (query.q || '').trim().toLowerCase();
  const prefecture = (query.prefecture || '').trim();
  const category   = (query.category || '').trim();
  const accepting  = query.accepting === '1' || query.accepting === 'true';
  const cursor     = query.cursor || null;

  const conds = [];
  const binds = [];
  if (q) {
    conds.push(`(LOWER(name) LIKE ? OR LOWER(IFNULL(name_kana, '')) LIKE ?)`);
    binds.push(`%${q}%`, `%${q}%`);
  }
  if (prefecture) { conds.push(`prefecture = ?`); binds.push(prefecture); }
  if (category)   { conds.push(`category = ?`);   binds.push(category); }
  if (accepting)  { conds.push(`accepting = 1`); }
  if (cursor)     { conds.push(`created_at < ?`); binds.push(cursor); }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  binds.push(limit);

  const r = await env.DB.prepare(`
    SELECT id, name, name_kana, prefecture, location, category, description,
           accepting, rank, website, report_base_url, logo_url, created_at
      FROM facilities
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
  `).bind(...binds).all();

  const facilities = r?.results || r || [];

  // 各施設の最新公開済報告書 (1件) を付加
  for (const f of facilities) {
    const latest = await env.DB.prepare(`
      SELECT period, url, published_at, status
        FROM facility_reports
        WHERE facility_id = ? AND status = 'published'
        ORDER BY period DESC
        LIMIT 1
    `).bind(f.id).first();
    f.latest_report = latest || null;
  }

  const nextCursor = facilities.length === limit ? facilities[facilities.length - 1].created_at : null;
  return { facilities, next_cursor: nextCursor, limit };
}

// =====================================================================
// 公開: 施設詳細
// =====================================================================
export async function getFacilityWithReports(env, facilityId) {
  const f = await env.DB.prepare(`SELECT * FROM facilities WHERE id = ? LIMIT 1`).bind(facilityId).first();
  if (!f) return null;
  const reports = await env.DB.prepare(`
    SELECT period, url, published_at, status
      FROM facility_reports
      WHERE facility_id = ? AND status = 'published'
      ORDER BY period DESC
  `).bind(facilityId).all();
  return { ...f, reports: reports?.results || reports || [] };
}

// 単体: 報告書一覧のみ (published のみ)
export async function listFacilityReports(env, facilityId, includeRetracted = false) {
  const stmt = includeRetracted
    ? `SELECT * FROM facility_reports WHERE facility_id = ? ORDER BY period DESC`
    : `SELECT * FROM facility_reports WHERE facility_id = ? AND status = 'published' ORDER BY period DESC`;
  const r = await env.DB.prepare(stmt).bind(facilityId).all();
  return r?.results || r || [];
}

// =====================================================================
// マイページ: 自分の支援先の月次報告書
// =====================================================================
export async function listMyFacilityReports(env, accountId) {
  const m = await env.DB.prepare(`SELECT current_facility_id FROM members WHERE account_id = ?`).bind(accountId).first();
  if (!m) return { facility: null, reports: [] };
  return getFacilityWithReports(env, m.current_facility_id).then(f => f ? ({ facility: f, reports: f.reports }) : ({ facility: null, reports: [] }));
}

// =====================================================================
// 施設管理者: 自施設の取得 / プロフィール更新
// =====================================================================
export async function getFacilityForAdminAccount(env, accountId) {
  const r = await env.DB.prepare(`
    SELECT f.*
      FROM facilities f
      JOIN facility_admins fa ON fa.facility_id = f.id
     WHERE fa.account_id = ?
     LIMIT 1
  `).bind(accountId).first();
  return r || null;
}

export async function updateFacilityProfile(env, facilityId, body) {
  const fields = ['name', 'name_kana', 'location', 'prefecture', 'category', 'description', 'website', 'report_base_url', 'logo_url', 'accepting'];
  const sets = []; const vals = [];
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(body[f]); }
  }
  if (sets.length === 0) return await env.DB.prepare(`SELECT * FROM facilities WHERE id = ?`).bind(facilityId).first();
  vals.push(facilityId);
  await env.DB.prepare(`UPDATE facilities SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return await env.DB.prepare(`SELECT * FROM facilities WHERE id = ?`).bind(facilityId).first();
}

// =====================================================================
// 施設管理者: 月次報告書URL 登録 (upsert)
// =====================================================================
//   body: { period: "YYYY-MM", url?: 完全URL (省略時は report_base_url + period で組み立て), notes?: string }
//   到達性確認はベストエフォート (HEAD) し、結果を verified_at に記録。
export async function registerFacilityReport(env, facility, body) {
  const period = String(body.period || '').trim();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return { ok: false, status: 400, error: 'invalid_period' };
  }
  let url = body.url;
  if (!url) {
    if (!facility.report_base_url) return { ok: false, status: 400, error: 'no_report_base_url' };
    url = `${facility.report_base_url.replace(/\/$/, '')}/${period}.html`;
  }

  let verifiedAt = null;
  // 簡易ヘルスチェック (本番運用では別途定期 ping。失敗してもステータスは published のまま許容)
  try {
    const hr = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (hr.ok) verifiedAt = new Date().toISOString();
  } catch (e) {
    console.warn('[facility-report] HEAD failed:', url, e.message);
  }

  // upsert
  const existing = await env.DB.prepare(`SELECT id FROM facility_reports WHERE facility_id = ? AND period = ?`)
    .bind(facility.id, period).first();
  if (existing) {
    await env.DB.prepare(`
      UPDATE facility_reports SET url = ?, status = 'published', verified_at = ?, notes = ?
       WHERE id = ?
    `).bind(url, verifiedAt, body.notes || null, existing.id).run();
    const updated = await env.DB.prepare(`SELECT * FROM facility_reports WHERE id = ?`).bind(existing.id).first();
    return { ok: true, report: updated, verified: !!verifiedAt };
  } else {
    const id = uuid();
    await env.DB.prepare(`
      INSERT INTO facility_reports (id, facility_id, period, url, status, verified_at, notes)
      VALUES (?, ?, ?, ?, 'published', ?, ?)
    `).bind(id, facility.id, period, url, verifiedAt, body.notes || null).run();
    const created = await env.DB.prepare(`SELECT * FROM facility_reports WHERE id = ?`).bind(id).first();
    return { ok: true, report: created, verified: !!verifiedAt };
  }
}

export async function retractFacilityReport(env, facilityId, reportId) {
  const r = await env.DB.prepare(`SELECT * FROM facility_reports WHERE id = ? AND facility_id = ?`)
    .bind(reportId, facilityId).first();
  if (!r) return { ok: false, status: 404, error: 'not_found' };
  await env.DB.prepare(`UPDATE facility_reports SET status = 'retracted' WHERE id = ?`).bind(reportId).run();
  return { ok: true };
}

// =====================================================================
// 施設管理者: 自施設のダッシュボード KPI
// =====================================================================
export async function facilityDashboardStats(env, facilityId) {
  const [supportersRow, totalPaidRow, thisMonthRow] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE current_facility_id = ?`).bind(facilityId).first(),
    env.DB.prepare(`SELECT COALESCE(SUM(total_paid_jpy),0) AS jpy FROM members WHERE current_facility_id = ?`).bind(facilityId).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE current_facility_id = ? AND substr(applied_at,1,7) = ?`)
      .bind(facilityId, new Date().toISOString().slice(0, 7)).first(),
  ]);
  return {
    supporters:         supportersRow?.n   || 0,
    total_paid_jpy:     totalPaidRow?.jpy  || 0,
    new_this_month:     thisMonthRow?.n    || 0,
  };
}

// =====================================================================
// 施設管理者: 自施設の支援者一覧 (個人情報は伏せる)
// =====================================================================
export async function facilitySupporters(env, facilityId) {
  const r = await env.DB.prepare(`
    SELECT
      substr(m.account_id, 1, 8) || '...' AS supporter_ref,
      m.applied_at, m.last_billed_at, m.total_paid_jpy
    FROM members m
    WHERE m.current_facility_id = ?
    ORDER BY m.applied_at DESC
  `).bind(facilityId).all();
  return r?.results || r || [];
}

// =====================================================================
// 運営: 全体 KPI
// =====================================================================
export async function adminOverview(env) {
  const [members, facilities, partners, coupons, used, reports] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_paid_jpy),0) AS paid FROM members`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM facilities`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM partners WHERE status = 'active'`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM coupons WHERE status = 'published'`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM member_coupons WHERE state = 'used'`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM facility_reports WHERE status = 'published'`).first(),
  ]);
  const mrr = (members?.n || 0) * 100; // 1人 ¥100/月
  return {
    members_count:     members?.n || 0,
    total_paid_jpy:    members?.paid || 0,
    mrr_jpy:           mrr,
    facilities_count:  facilities?.n || 0,
    partners_count:    partners?.n || 0,
    published_coupons: coupons?.n || 0,
    used_coupons:      used?.n || 0,
    published_reports: reports?.n || 0,
  };
}

export async function adminListFacilities(env) {
  const r = await env.DB.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM members m WHERE m.current_facility_id = f.id) AS supporters_count,
      (SELECT COUNT(*) FROM facility_reports fr WHERE fr.facility_id = f.id AND fr.status = 'published') AS published_reports_count,
      (SELECT MAX(period)  FROM facility_reports fr WHERE fr.facility_id = f.id AND fr.status = 'published') AS latest_report_period
    FROM facilities f
    ORDER BY f.created_at DESC
  `).all();
  return r?.results || r || [];
}

export async function adminListPartners(env) {
  const r = await env.DB.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM coupons c WHERE c.partner_id = p.id) AS coupons_count,
      (SELECT COUNT(*) FROM member_coupons mc JOIN coupons c ON c.id=mc.coupon_id WHERE c.partner_id = p.id AND mc.state='used') AS used_count
    FROM partners p
    ORDER BY p.created_at DESC
  `).all();
  return r?.results || r || [];
}

export async function adminListMembers(env, limit = 100) {
  const r = await env.DB.prepare(`
    SELECT a.id, a.email, a.role, a.display_name, a.created_at,
           m.square_subscription_id, m.current_facility_id, m.last_billed_at, m.total_paid_jpy
    FROM accounts a
    LEFT JOIN members m ON m.account_id = a.id
    WHERE a.role = 'member'
    ORDER BY a.created_at DESC
    LIMIT ?
  `).bind(limit).all();
  return r?.results || r || [];
}

export async function adminListReports(env) {
  const r = await env.DB.prepare(`
    SELECT fr.*, f.name AS facility_name
    FROM facility_reports fr
    JOIN facilities f ON f.id = fr.facility_id
    ORDER BY fr.period DESC, f.name ASC
  `).all();
  return r?.results || r || [];
}
