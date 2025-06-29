import puppeteer from 'puppeteer';
import * as dotenv from 'dotenv';
import { authenticator } from 'otplib';
import { join } from 'path';
import { writeFileSync } from 'fs';

dotenv.config();

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox'],
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
    await page.goto(bitwardenUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    console.log('Page loaded.');

    // Type in email
    await page.click('input#login_input_email');
    await page.keyboard.type(email, { delay: 10 });
    console.log('Email entered.');

    // Click the Continue button
    await page.evaluate(() => {
      const continueButton = Array.from(
        document.querySelectorAll('button')
      ).find((button) => button.textContent?.includes('Continue'));
      if (continueButton) {
        (continueButton as HTMLElement).click();
      }
    });
    console.log('Clicked Continue button after email.');

    // Type in password
    await page.click('input#login_input_master-password');
    await page.keyboard.type(password, { delay: 10 });
    console.log('Password entered.');

    // Click Log In button
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    console.log('Clicked Log In button.');

    // Wait for navigation
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
    console.log('Navigation after Log In.');

    // Handle potential 2FA step
    const twoFactorInputSelector = 'input#code';

    if (await page.$(twoFactorInputSelector)) {
      console.log('Two-factor authentication step detected');

      // Generate OTP code
      const otpCode = authenticator.generate(otpSecret);

      await page.click(twoFactorInputSelector);
      await page.keyboard.type(otpCode, { delay: 10 });
      console.log('OTP code entered.');

      // Ensure the OTP input field loses focus
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      console.log('Navigation after clicking Continue.');
    }

    console.log('Logged in successfully.');

    // Navigate to settings page directly
    const settingsUrl = `${bitwardenUrl}/#/settings`;
    await page.goto(settingsUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('Navigated to settings page.');

    try {
      const buttonClicked: boolean = await page.evaluate(() => {
        const findPurgeButton = (): HTMLButtonElement | undefined => {
          const buttons = Array.from(
            document.querySelectorAll("button[type='button']")
          );
          return buttons.find((button) =>
            button.textContent?.trim().includes('Purge vault')
          ) as HTMLButtonElement | undefined;
        };

        const purgeButton = findPurgeButton();

        if (purgeButton) {
          purgeButton.scrollIntoView();
          (purgeButton as HTMLElement).click();
          return true;
        } else {
          return false;
        }
      });

      if (buttonClicked) {
        console.log('Clicked the "Purge vault" button.');
      } else {
        throw new Error('Purge vault button not found.');
      }
    } catch (error) {
      console.error(`An error occurred: ${error}`);
    }

    // Wait for 2 seconds before typing the password
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Start typing the password directly
    await page.keyboard.type(password, { delay: 10 });
    console.log('Typed the master password for confirmation.');

    // Click the final Purge Vault confirmation button
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
      const confirmPurgeButton = document.querySelector(
        'form .modal-footer .btn.btn-danger.btn-submit'
      );
      if (confirmPurgeButton) {
        (confirmPurgeButton as HTMLElement).click();
      }
    });
    console.log('Clicked the final "Purge vault" confirmation button.');

    // Wait for the purge to complete
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
    console.log('Purge completed successfully.');
  } catch (error) {
    console.error('An error occurred:', error);

    // Take a screenshot if an error occurs
    const screenshotPath = join('/bitwardensync/data', 'error_screenshot.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved at ${screenshotPath}`);

    // Save the error message to a file
    const errorMessagePath = join('/bitwardensync/data', 'error_message.txt');

    // Check the type of error and handle accordingly
    if (error instanceof Error) {
      writeFileSync(errorMessagePath, error.message);
    } else {
      writeFileSync(errorMessagePath, 'An unknown error occurred.');
    }

    console.log(`Error message saved at ${errorMessagePath}`);
  } finally {
    // Close the browser
    await browser.close();
  }
})();
