"""
جلب صفحات qanoon.om.

الوضع الافتراضي: requests + BeautifulSoup (سريع وخفيف).
إن تبيّن أن المحتوى يُبنى عبر JavaScript، فعّل USE_PLAYWRIGHT في config.py
واستخدم fetch_rendered_html بدل fetch_html.
"""

import requests
from bs4 import BeautifulSoup

import config


def fetch_html(url: str) -> BeautifulSoup:
    resp = requests.get(url, headers=config.HTTP_HEADERS, timeout=config.HTTP_TIMEOUT)
    resp.raise_for_status()
    resp.encoding = resp.apparent_encoding or "utf-8"
    return BeautifulSoup(resp.text, "html.parser")


def fetch_rendered_html(url: str) -> BeautifulSoup:
    """يُستخدم فقط إذا كان المحتوى يحتاج تنفيذ JavaScript (Playwright)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(user_agent=config.HTTP_HEADERS["User-Agent"])
        page.goto(url, timeout=config.HTTP_TIMEOUT * 1000)
        page.wait_for_load_state("networkidle")
        html = page.content()
        browser.close()
    return BeautifulSoup(html, "html.parser")


def get_soup(url: str) -> BeautifulSoup:
    if config.USE_PLAYWRIGHT:
        return fetch_rendered_html(url)
    return fetch_html(url)
