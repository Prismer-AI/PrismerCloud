from playwright.sync_api import sync_playwright
import os
import tempfile
from pathlib import Path

# Example: Automating interaction with static HTML files using file:// URLs

html_file_path = Path(os.environ['WEBAPP_TEST_HTML']).resolve(strict=True)
file_url = html_file_path.as_uri()
output_dir = Path(os.environ.get('PRISMER_ARTIFACTS_DIR') or tempfile.mkdtemp(prefix='webapp-test-'))
output_dir.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1920, 'height': 1080})

    # Navigate to local HTML file
    page.goto(file_url)

    # Take screenshot
    page.screenshot(path=str(output_dir / 'static_page.png'), full_page=True)

    # Interact with elements
    if os.environ.get('WEBAPP_TEST_SUBMIT_FIXTURE') == '1':
        page.click('text=Click Me')
        page.fill('#name', 'John Doe')
        page.fill('#email', 'john@example.com')

    # Submit form
        page.click('button[type="submit"]')
    page.wait_for_timeout(500)

    # Take final screenshot
    page.screenshot(path=str(output_dir / 'after_submit.png'), full_page=True)

    browser.close()

print("Static HTML automation completed!")
