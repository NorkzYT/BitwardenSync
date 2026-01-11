import puppeteer from 'puppeteer';
import * as dotenv from 'dotenv';
import { authenticator } from 'otplib';
import { join } from 'path';
import { writeFileSync } from 'fs';

dotenv.config();

const DATA_DIR = '/bitwardensync/data';

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false, // Must be false for visual automation
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--start-maximized',
      '--window-size=1920,1080',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const bitwardenUrl = process.env.BITWARDEN_SYNC_HOST as string;
  const email = process.env.BITWARDEN_SYNC_BW_EMAIL_ADDRESS as string;
  const password = process.env.BITWARDEN_SYNC_BW_PASSWORD as string;
  const otpSecret = process.env.BITWARDEN_SYNC_BW_OTP_CODE as string;

  if (!bitwardenUrl || !email || !password || !otpSecret) {
    console.error(
      'Host, email, password, or OTP secret environment variables are not set'
    );
    process.exit(1);
  }

  try {
    // Phase 1: Navigate directly to settings/account page
    // This will redirect to login, and after login will redirect back to settings
    const targetUrl = `${bitwardenUrl}/#/settings/account`;
    console.log(`Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    console.log('Page loaded (redirected to login).');

    // Wait for page to stabilize and ensure browser has focus
    await sleep(2000);

    // Phase 2: Login via Puppeteer keyboard (direct browser control)
    // Email field is already focused by default - type directly
    console.log('Entering email (field should be auto-focused)...');
    await page.keyboard.type(email, { delay: 10 });
    console.log('Email entered.');

    // Tab order: Email → Checkbox → Continue → Create account
    // We need: Tab (checkbox) → Tab (Continue) → Enter
    await sleep(300);
    console.log('Pressing Tab to move to checkbox...');
    await page.keyboard.press('Tab');

    await sleep(100);
    console.log('Pressing Tab to move to Continue button...');
    await page.keyboard.press('Tab');

    await sleep(100);
    console.log('Pressing Enter to click Continue...');
    await page.keyboard.press('Enter');
    console.log('Clicked Continue button.');

    // Wait for password page to load
    await sleep(3000);

    // Password field should be auto-focused - type directly (no Tab)
    console.log('Entering password (field should be auto-focused)...');
    await page.keyboard.type(password, { delay: 10 });
    console.log('Password entered.');

    // Tab order on password page: Password → Show password → Log in with device → Log in
    // After typing password, we need to Tab to "Log in" button
    await sleep(300);
    console.log('Navigating to Log In button...');
    await page.keyboard.press('Tab'); // Show password toggle
    await sleep(100);
    await page.keyboard.press('Tab'); // Log in with device
    await sleep(100);
    await page.keyboard.press('Tab'); // Log in button
    await sleep(100);
    await page.keyboard.press('Enter'); // Submit login
    console.log('Clicked Log In button.');

    // Wait for 2FA page or vault
    await sleep(4000);

    // Generate and enter OTP (assuming 2FA is enabled)
    console.log('Generating OTP code...');
    const otpCode = authenticator.generate(otpSecret);
    console.log(`OTP code generated: ${otpCode}`);

    // 2FA input should be auto-focused - type directly (no Tab)
    console.log('Entering OTP code (field should be auto-focused)...');
    await page.keyboard.type(otpCode, { delay: 10 });
    console.log('OTP code entered.');

    // Tab to Continue button and submit
    // Tab order: OTP input → "Don't ask again" checkbox → "Continue logging in" button
    await sleep(300);
    console.log('Tab 1: Moving to checkbox...');
    await page.keyboard.press('Tab');
    await sleep(200);

    console.log('Tab 2: Moving to Continue button...');
    await page.keyboard.press('Tab');
    await sleep(200);

    console.log('Pressing Enter to submit 2FA...');
    await page.keyboard.press('Enter');
    await sleep(1000);
    console.log('Submitted 2FA.');

    // Wait for redirect to settings page (after successful login)
    await sleep(5000);
    console.log(
      'Logged in successfully - should be redirected to settings page.'
    );

    // Navigate to Purge Vault button: Shift+Tab 4 times (go backwards)
    console.log('Navigating to Purge vault button (Shift+Tab 4 times)...');
    for (let i = 1; i <= 4; i++) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      await sleep(100);
    }

    // Press Enter to click the Purge Vault button
    console.log('Pressing Enter on Purge vault button...');
    await page.keyboard.press('Enter');
    await sleep(2000);

    // Type master password for confirmation (field should be auto-focused)
    console.log('Entering master password for confirmation...');
    await page.keyboard.type(password, { delay: 10 });
    console.log('Password entered for confirmation.');

    // Tab 2 times to reach confirm button, then Enter
    await sleep(300);
    console.log('Tab 1: Moving towards confirm button...');
    await page.keyboard.press('Tab');
    await sleep(100);
    console.log('Tab 2: Should be on confirm button...');
    await page.keyboard.press('Tab');
    await sleep(100);

    console.log('Pressing Enter to confirm purge...');
    await page.keyboard.press('Enter');
    console.log('Clicked final Purge vault confirmation.');

    // Wait for purge to complete
    await sleep(5000);
    console.log('Purge completed successfully.');
  } catch (error) {
    console.error('An error occurred:', error);

    // Take debug screenshots
    try {
      // Puppeteer screenshot (DOM-based)
      const puppeteerScreenshot = join(DATA_DIR, 'error_screenshot.png');
      await page.screenshot({ path: puppeteerScreenshot });
      console.log(`Puppeteer screenshot saved: ${puppeteerScreenshot}`);
    } catch (e) {
      console.error('Failed to save Puppeteer screenshot:', e);
    }

    // Save error message
    const errorMessagePath = join(DATA_DIR, 'error_message.txt');
    if (error instanceof Error) {
      writeFileSync(errorMessagePath, error.message);
    } else {
      writeFileSync(errorMessagePath, 'An unknown error occurred.');
    }
    console.log(`Error message saved: ${errorMessagePath}`);

    process.exit(1);
  } finally {
    await browser.close();
  }
})();
