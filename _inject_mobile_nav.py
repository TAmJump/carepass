#!/usr/bin/env python3
"""
CSPメインサイトの全ページに、共通の三本線メニュー / drawer / lightbox を挿入する。
- <head> に <link rel="stylesheet" href="/assets/mobile-nav.css?v=20260521a">
- <div class="nav-cta"> ... </div> の閉じ直後に <button class="nav-toggle">
- </nav> の直後に <aside class="nav-drawer">
- </body> 前に <script src="/assets/mobile-ux.js?v=20260521a" defer>
冪等 (既に挿入済みなら何もしない)。
"""

import re
import os
import sys

ROOT = "/home/claude/work/carepass"

# 全ページに共通の drawer リンク (active判定は各ページで)
NAV_LINKS = [
    # (label, href, button_action_or_None)
    ("Care Support Pass トップ", "/", None),
    ("導入施設を見る",            "/facilities-directory.html", None),
    ("協力会社の方へ",            "/partners.html", None),
    ("介護施設の方へ",            "/facilities.html", None),
    ("コンセプト",                "/concept.html", None),
    ("マイページ",                "/mypage.html", None),
]

# 各ページの active 判定
PAGE_ACTIVE_MAP = {
    "index.html":                "/",
    "facilities-directory.html": "/facilities-directory.html",
    "partners.html":             "/partners.html",
    "facilities.html":           "/facilities.html",
    "concept.html":              "/concept.html",
    "mypage.html":               "/mypage.html",
    # ダッシュボード系
    "admin.html":                None,
    "partner-dashboard.html":    None,
    "facility-dashboard.html":   None,
}

# 各ページの drawer 内 CTA ボタン
PAGE_CTA = {
    # primary 参加するボタン: 公開ページ群のみ
    "index.html":                ('button', "go('apply')", "今すぐ参加する"),
    "facilities-directory.html": ('a',      "/#apply",     "今すぐ参加する"),
    "partners.html":             ('a',      "/#apply",     "今すぐ参加する"),
    "facilities.html":           ('a',      "/#apply",     "今すぐ参加する"),
    "concept.html":              ('a',      "/#apply",     "今すぐ参加する"),
    "mypage.html":               None,  # ログインフォームのみ
    "admin.html":                None,
    "partner-dashboard.html":    None,
    "facility-dashboard.html":   None,
}

HAMBURGER_BTN = '''    <button class="nav-toggle" aria-label="メニューを開く" aria-expanded="false" aria-controls="nav-drawer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <line x1="3" y1="6" x2="21" y2="6"/>
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
'''


def build_drawer(active_href, cta):
    """ページごとの drawer HTML を生成"""
    links_html = []
    for label, href, _ in NAV_LINKS:
        active = ' class="active"' if href == active_href else ''
        links_html.append(f'    <a href="{href}"{active}>{label}</a>')
    cta_html = ''
    if cta:
        kind, target, label = cta
        if kind == 'button':
            cta_html = (
                '  <div class="nav-drawer-cta">\n'
                f'    <button class="btn primary" onclick="{target}">{label}</button>\n'
                '  </div>\n'
            )
        else:
            cta_html = (
                '  <div class="nav-drawer-cta">\n'
                f'    <a class="btn primary" href="{target}">{label}</a>\n'
                '  </div>\n'
            )

    return (
        '\n<!-- Mobile drawer -->\n'
        '<div class="nav-drawer-backdrop" aria-hidden="true"></div>\n'
        '<aside class="nav-drawer" id="nav-drawer" aria-label="メニュー">\n'
        '  <div class="nav-drawer-head">\n'
        '    <span class="label">Care Support Pass</span>\n'
        '    <span class="title">メニュー</span>\n'
        '  </div>\n'
        '  <nav class="nav-drawer-links">\n'
        + '\n'.join(links_html) + '\n'
        '  </nav>\n'
        + cta_html +
        '</aside>\n'
    )


CSS_TAG = '<link rel="stylesheet" href="/assets/mobile-nav.css?v=20260521a">'
JS_TAG = '<script src="/assets/mobile-ux.js?v=20260521a" defer></script>'


def inject_page(fname):
    path = os.path.join(ROOT, fname)
    if not os.path.exists(path):
        print(f'  skip (not found): {fname}')
        return False
    with open(path, encoding='utf-8') as f:
        s = f.read()
    original = s

    # 1) CSS link 挿入 (まだ無ければ)
    if 'mobile-nav.css' not in s:
        # </head> の前に
        s = s.replace('</head>', f'{CSS_TAG}\n</head>', 1)

    # 2) Hamburger button 挿入 (まだ無ければ)
    if 'class="nav-toggle"' not in s:
        # </nav> の直前に挿入 (nav-cta の閉じ後)
        idx = s.find('</nav>')
        if idx != -1:
            # nav-cta の </div> の直後にしたい
            # 簡易: </nav> の直前に置く
            s = s[:idx] + HAMBURGER_BTN + s[idx:]

    # 3) Drawer 挿入 (まだ無ければ)
    if 'nav-drawer-backdrop' not in s:
        active = PAGE_ACTIVE_MAP.get(fname)
        cta = PAGE_CTA.get(fname)
        drawer = build_drawer(active, cta)
        # </nav> の直後 (最初のもの)
        s = s.replace('</nav>\n', '</nav>\n' + drawer, 1)
        # 万一改行違いだった場合のフォールバック
        if 'nav-drawer-backdrop' not in s:
            s = s.replace('</nav>', '</nav>\n' + drawer, 1)

    # 4) script tag 挿入 (まだ無ければ)
    if 'mobile-ux.js' not in s:
        s = s.replace('</body>', f'{JS_TAG}\n</body>', 1)

    if s == original:
        print(f'  no-change: {fname}')
        return False
    with open(path, 'w', encoding='utf-8') as f:
        f.write(s)
    print(f'  updated: {fname}')
    return True


def main():
    targets = [
        "index.html",
        "facilities-directory.html",
        "partners.html",
        "facilities.html",
        "concept.html",
        "mypage.html",
        "admin.html",
        "partner-dashboard.html",
        "facility-dashboard.html",
    ]
    for f in targets:
        inject_page(f)


if __name__ == '__main__':
    main()
