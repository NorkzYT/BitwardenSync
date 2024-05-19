import puppeteer from 'puppeteer';
import * as dotenv from 'dotenv';
import { authenticator } from 'otplib';

dotenv.config();

(async () => {
  const browser = await puppeteer.launch({ headless: true });
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
    await page.goto(bitwardenUrl, { waitUntil: 'networkidle2' });

    // Type in email
    await page.click('input#email');
    await page.keyboard.type(email, { delay: 10 });

    // Type in password
    await page.click('input#masterPassword');
    await page.keyboard.type(password, { delay: 10 });

    // Click Log In button
    await page.click('button.btn-submit');

    // Wait for navigation
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // Handle potential 2FA step
    const twoFactorInputSelector = 'input#code';
    const twoFactorContinueSelector = 'button.btn-submit';

    if (await page.$(twoFactorInputSelector)) {
      console.log('Two-factor authentication step detected');

      // Generate OTP code
      const otpCode = authenticator.generate(otpSecret);

      await page.click(twoFactorInputSelector);
      await page.keyboard.type(otpCode, { delay: 10 });
      await page.click(twoFactorContinueSelector);

      // Wait for navigation
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
    }

    // Click on Settings
    await page.click('a[href="#/settings"]');

    // Wait for the card-body containing the "Purge Vault" button
    await page.waitForSelector('.card-body', { visible: true });

    // Scroll all the way down
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    console.log('Scrolled to the bottom of the page.');

    // Wait for the "Purge Vault" button to be in the viewport and click it
    await page.waitForSelector('button.btn-outline-danger', { visible: true });
    await page.evaluate(() => {
      const purgeButton = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('Purge Vault')
      );
      if (purgeButton) {
        purgeButton.scrollIntoView();
        purgeButton.click();
      }
    });

    console.log('Clicked the "Purge Vault" button.');

    // Wait for 2 seconds before typing the password
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Start typing the password directly
    await page.keyboard.type(password, { delay: 10 });
    console.log('Typed the master password for confirmation.');

    // Click the final Purge Vault confirmation button
    await page.waitForSelector(
      'form .modal-footer .btn.btn-danger.btn-submit',
      { visible: true }
    );
    await page.evaluate(() => {
      const confirmPurgeButton = document.querySelector(
        'form .modal-footer .btn.btn-danger.btn-submit'
      );
      if (confirmPurgeButton) {
        (confirmPurgeButton as HTMLElement).click();
      }
    });

    console.log('Clicked the final "Purge Vault" confirmation button.');

    // Wait for the purge to complete
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    // Close the browser
    await browser.close();
  }
})();
