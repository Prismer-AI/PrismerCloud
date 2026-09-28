from playwright.sync_api import sync_playwright
import os
import tempfile
from pathlib import Path

# Example: Capturing console logs during browser automation

url = os.environ['WEBAPP_TEST_URL']
output_dir = Path(os.environ.get('PRISMER_ARTIFACTS_DIR') or tempfile.mkdtemp(prefix='webapp-test-'))
output_dir.mkdir(parents=True, exist_ok=True)

console_logs = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1920, 'height': 1080})

    # Set up console log capture
    def handle_console_message(msg):
        console_logs.append(f"[{msg.type}] {msg.text}")
        print(f"Console: [{msg.type}] {msg.text}")

    page.on("console", handle_console_message)

    # Navigate to page
    page.goto(url)
    page.wait_for_load_state('networkidle')

    # Interact with the page (triggers console logs)
    if os.environ.get('WEBAPP_TEST_CLICK_SELECTOR'):
        page.click(os.environ['WEBAPP_TEST_CLICK_SELECTOR'])
    page.wait_for_timeout(1000)

    browser.close()

# Save console logs to file
with (output_dir / 'console.log').open('w') as f:
    f.write('\n'.join(console_logs))

print(f"\nCaptured {len(console_logs)} console messages")
print(f"Logs saved to: {output_dir / 'console.log'}")
