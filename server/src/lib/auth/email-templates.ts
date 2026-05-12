/**
 * Verification email templates — visually identical to the Go backend's
 * services/email/email.go output so users don't see a sudden change of
 * branding/voice when we cut traffic from Go to native auth.
 *
 * Subject lines are byte-identical. HTML body is the same gradient
 * design (purple for signup, orange for reset-password) with the same
 * security tips and footer.
 *
 * Plain-text fallback is added (Go didn't have one) — accessibility +
 * better spam-filter heuristics.
 */

export type CodePurpose = 'signup' | 'reset-password';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const TTL_LABEL = '5 minutes';

export function renderEmailTemplate(code: string, purpose: CodePurpose): RenderedEmail {
  if (purpose === 'signup') {
    return {
      subject: 'Prismer - Verification Code for Registration',
      text: signupText(code),
      html: signupHtml(code),
    };
  }
  return {
    subject: 'Prismer - Password Reset Verification Code',
    text: resetText(code),
    html: resetHtml(code),
  };
}

// ─── plain-text fallbacks (not in Go; added for spam filters + a11y)

function signupText(code: string): string {
  return `Prismer — Registration Verification Code

Your verification code is: ${code}

This code is valid for ${TTL_LABEL}.

If you did not request this registration, please ignore this email.

— Prismer
`;
}

function resetText(code: string): string {
  return `Prismer — Password Reset Verification Code

Your verification code is: ${code}

This code is valid for ${TTL_LABEL}.

IMPORTANT: If you did not request a password reset, please contact support immediately.

— Prismer
`;
}

// ─── HTML templates — ported verbatim from services/email/email.go
// (gradient + security-tips + footer block; the only %s placeholder is
// the verification code).

function signupHtml(code: string): string {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Registration Verification Code</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    </style>
</head>
<body style="font-family: 'Inter', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f6f8;">
    <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <!-- Header with Logo -->
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px; text-align: center;">
            <div style="display: inline-block; background: #ffffff; padding: 15px 25px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
                <h1 style="margin: 0; color: #667eea; font-size: 32px; font-weight: 700; letter-spacing: -1px;">
                    <span style="background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">Prismer</span>
                </h1>
            </div>
        </div>

        <!-- Content -->
        <div style="padding: 40px 30px;">
            <div style="text-align: center; margin-bottom: 30px;">
                <h2 style="color: #1a202c; margin: 0 0 10px 0; font-size: 28px; font-weight: 600;">Registration Verification Code</h2>
                <p style="color: #718096; font-size: 16px; margin: 0;">Complete your registration to get started</p>
            </div>

            <div style="background: linear-gradient(135deg, #f7fafc 0%, #edf2f7 100%); padding: 30px; border-radius: 16px; margin: 30px 0; border: 1px solid #e2e8f0;">
                <p style="color: #2d3748; font-size: 16px; margin-bottom: 20px;">Hello!</p>
                <p style="color: #2d3748; font-size: 16px; margin-bottom: 25px;">Thank you for registering with <strong style="color: #667eea;">Prismer</strong>. Your verification code is:</p>

                <div style="text-align: center; margin: 35px 0;">
                    <div style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 4px; border-radius: 16px; box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);">
                        <span style="display: inline-block; font-size: 36px; font-weight: 700; color: #ffffff; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px 35px; border-radius: 12px; letter-spacing: 8px; font-family: 'Courier New', monospace;">${code}</span>
                    </div>
                </div>

                <div style="background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 15px; margin: 25px 0;">
                    <p style="color: #000000; font-size: 14px; margin: 0;">
                        ⏱️ This verification code is valid for <strong>${TTL_LABEL}</strong>. Please complete the verification process as soon as possible.
                    </p>
                </div>

                <p style="color: #718096; font-size: 14px; margin: 20px 0 0 0;">If you did not request this registration, please ignore this email.</p>
            </div>

            <!-- Security Tips -->
            <div style="background: #f0fff4; border: 1px solid #9ae6b4; border-radius: 8px; padding: 20px; margin: 25px 0;">
                <h4 style="color: #22543d; margin: 0 0 10px 0; font-size: 16px;">🔒 Security Tips</h4>
                <ul style="color: #276749; font-size: 14px; margin: 0; padding-left: 20px;">
                    <li>Never share your verification code with anyone</li>
                    <li>Prismer will never ask for your code via phone or other channels</li>
                    <li>If you suspect unauthorized access, contact support immediately</li>
                </ul>
            </div>
        </div>

        <!-- Footer -->
        <div style="background: #f7fafc; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="color: #a0aec0; font-size: 12px; margin: 0 0 5px 0;">This email was sent automatically by the system. Please do not reply.</p>
            <p style="color: #a0aec0; font-size: 12px; margin: 0;">© 2024 <strong style="color: #667eea;">Prismer</strong>. All rights reserved.</p>
            <div style="margin-top: 15px;">
                <a href="#" style="color: #667eea; text-decoration: none; font-size: 12px; margin: 0 10px;">Privacy Policy</a>
                <a href="#" style="color: #667eea; text-decoration: none; font-size: 12px; margin: 0 10px;">Terms of Service</a>
                <a href="#" style="color: #667eea; text-decoration: none; font-size: 12px; margin: 0 10px;">Support</a>
            </div>
        </div>
    </div>
</body>
</html>`;
}

function resetHtml(code: string): string {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Password Reset Verification Code</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    </style>
</head>
<body style="font-family: 'Inter', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f6f8;">
    <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <!-- Header with Logo -->
        <div style="background: linear-gradient(135deg, #f39c12 0%, #e67e22 100%); padding: 40px 20px; text-align: center;">
            <div style="display: inline-block; background: #ffffff; padding: 15px 25px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
                <h1 style="margin: 0; color: #f39c12; font-size: 32px; font-weight: 700; letter-spacing: -1px;">
                    <span style="background: linear-gradient(135deg, #f39c12, #e67e22); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">Prismer</span>
                </h1>
            </div>
        </div>

        <!-- Content -->
        <div style="padding: 40px 30px;">
            <div style="text-align: center; margin-bottom: 30px;">
                <h2 style="color: #1a202c; margin: 0 0 10px 0; font-size: 28px; font-weight: 600;">Password Reset Verification Code</h2>
                <p style="color: #718096; font-size: 16px; margin: 0;">Secure your account with a new password</p>
            </div>

            <div style="background: linear-gradient(135deg, #f7fafc 0%, #edf2f7 100%); padding: 30px; border-radius: 16px; margin: 30px 0; border: 1px solid #e2e8f0;">
                <p style="color: #2d3748; font-size: 16px; margin-bottom: 20px;">Hello!</p>
                <p style="color: #2d3748; font-size: 16px; margin-bottom: 25px;">You have requested to reset your <strong style="color: #f39c12;">Prismer</strong> account password. Your verification code is:</p>

                <div style="text-align: center; margin: 35px 0;">
                    <div style="display: inline-block; background: linear-gradient(135deg, #f39c12 0%, #e67e22 100%); padding: 4px; border-radius: 16px; box-shadow: 0 8px 25px rgba(243, 156, 18, 0.3);">
                        <span style="display: inline-block; font-size: 36px; font-weight: 700; color: #ffffff; background: linear-gradient(135deg, #f39c12 0%, #e67e22 100%); padding: 20px 35px; border-radius: 12px; letter-spacing: 8px; font-family: 'Courier New', monospace;">${code}</span>
                    </div>
                </div>

                <div style="background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 15px; margin: 25px 0;">
                    <p style="color: #000000; font-size: 14px; margin: 0;">
                        ⏱️ This verification code is valid for <strong>${TTL_LABEL}</strong>. Please complete the password reset process as soon as possible.
                    </p>
                </div>

                <div style="background: #fed7d7; border: 1px solid #fc8181; border-radius: 8px; padding: 15px; margin: 25px 0;">
                    <p style="color: #c53030; font-size: 14px; margin: 0;">
                        🚨 <strong>Important:</strong> If you did not request a password reset, please contact us immediately!
                    </p>
                </div>
            </div>

            <!-- Security Tips -->
            <div style="background: #f0fff4; border: 1px solid #9ae6b4; border-radius: 8px; padding: 20px; margin: 25px 0;">
                <h4 style="color: #22543d; margin: 0 0 10px 0; font-size: 16px;">🔒 Security Tips</h4>
                <ul style="color: #276749; font-size: 14px; margin: 0; padding-left: 20px;">
                    <li>Never share your verification code with anyone</li>
                    <li>Choose a strong password with at least 8 characters</li>
                    <li>Consider enabling two-factor authentication</li>
                </ul>
            </div>
        </div>

        <!-- Footer -->
        <div style="background: #f7fafc; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="color: #a0aec0; font-size: 12px; margin: 0 0 5px 0;">This email was sent automatically by the system. Please do not reply.</p>
            <p style="color: #a0aec0; font-size: 12px; margin: 0;">© 2024 <strong style="color: #f39c12;">Prismer</strong>. All rights reserved.</p>
            <div style="margin-top: 15px;">
                <a href="#" style="color: #f39c12; text-decoration: none; font-size: 12px; margin: 0 10px;">Privacy Policy</a>
                <a href="#" style="color: #f39c12; text-decoration: none; font-size: 12px; margin: 0 10px;">Terms of Service</a>
                <a href="#" style="color: #f39c12; text-decoration: none; font-size: 12px; margin: 0 10px;">Support</a>
            </div>
        </div>
    </div>
</body>
</html>`;
}
