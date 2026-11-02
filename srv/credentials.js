'use strict'
/**
 * Credential loader for the Purchase Order MCP server.
 * Auth method: Basic Auth (SAP user + password) only.
 *
 * Priority order (first match wins):
 *
 *   1. Windows Credential Manager (target "PO_MCP")
 *        cmdkey /add:PO_MCP /user:<SAP_USER> /pass:<SAP_PASSWORD>
 *
 *   2. .env file (SAP_USER + SAP_PASSWORD — never commit this file)
 *
 *   3. Plain environment variables (least preferred)
 *
 * SAP_BASE_URL, SAP_CLIENT and SAP_SERVICE_PATH are always read from .env or environment.
 */

const path = require('path')
const { execSync } = require('child_process')

const ENV_FILE = path.join(__dirname, '..', '.env')

// Load .env once at startup (won't override existing env vars)
try {
  require('dotenv').config({ path: ENV_FILE, override: false })
} catch {
  // dotenv not available or file missing – continue
}

const CRED_TARGET = process.env.SAP_CRED_TARGET || 'PO_MCP'

/**
 * Try to read a credential from Windows Credential Manager.
 * Returns { user, pass } or null if not found / not on Windows.
 */
function readWindowsCredential(target) {
  if (process.platform !== 'win32') return null

  if (!/^[\w\-.:]+$/.test(target)) {
    throw new Error(`Credential target contains unsafe characters: "${target}"`)
  }

  const env = { ...process.env, _MCP_CRED_TARGET: target }

  try {
    // Windows PasswordVault (UWP credential store, no admin required)
    const script = [
      'try {',
      '  $cm = [Windows.Security.Credentials.PasswordVault]::new()',
      '  $c  = $cm.Retrieve($env:_MCP_CRED_TARGET, $null)',
      '  $c.RetrievePassword()',
      '  Write-Output "$($c.UserName)`t$($c.Password)"',
      '} catch {}'
    ].join(' ')

    const result = execSync(
      `powershell -NoProfile -NonInteractive -Command "${script}"`,
      { timeout: 5000, env, stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim()

    if (result.includes('\t')) {
      const [user, pass] = result.split('\t')
      return { user: user.trim(), pass: pass.trim() }
    }
  } catch {
    // PasswordVault not available — try legacy DPAPI store
  }

  try {
    // Legacy Windows Credential Manager (DPAPI-backed, requires CredentialManager PS module)
    const script = [
      '$cred = Get-StoredCredential -Target $env:_MCP_CRED_TARGET -ErrorAction Stop 2>$null',
      'if ($cred) { Write-Output "$($cred.UserName)`t$($cred.GetNetworkCredential().Password)" }'
    ].join('; ')

    const r = execSync(
      `powershell -NoProfile -NonInteractive -Command "${script}"`,
      { timeout: 5000, env, stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim()

    if (r.includes('\t')) {
      const [user, pass] = r.split('\t')
      return { user: user.trim(), pass: pass.trim() }
    }
  } catch {
    // Module not installed or credential not found
  }

  return null
}

/**
 * Returns { baseUrl, client, servicePath, user, pass }.
 * Throws with a clear message when required settings are missing.
 */
function loadCredentials() {
  const baseUrl = process.env.SAP_BASE_URL?.replace(/\/+$/, '')
  const client = process.env.SAP_CLIENT || ''
  const servicePath = process.env.SAP_SERVICE_PATH

  if (!baseUrl) {
    throw new Error(
      'SAP_BASE_URL is not set.\n' +
      'Add it to .env or set it as an environment variable.\n' +
      'Example: SAP_BASE_URL=https://your-sap-host:44300'
    )
  }

  if (!servicePath) {
    throw new Error(
      'SAP_SERVICE_PATH is not set.\n' +
      'Add the full OData V4 service root path to .env, e.g.:\n' +
      'SAP_SERVICE_PATH=/sap/opu/odata4/sap/<service-binding>/srvd/sap/zpru_purcorderhdr_odata/0001/'
    )
  }

  const winCred = readWindowsCredential(CRED_TARGET)
  if (winCred) {
    return { baseUrl, client, servicePath, user: winCred.user, pass: winCred.pass }
  }

  const user = process.env.SAP_USER
  const pass = process.env.SAP_PASSWORD
  if (user && pass) {
    return { baseUrl, client, servicePath, user, pass }
  }

  throw new Error(
    'No SAP credentials found. Provide them via one of:\n\n' +
    `  1. Windows Credential Manager:\n       cmdkey /add:${CRED_TARGET} /user:<SAP_USER> /pass:<SAP_PASSWORD>\n\n` +
    '  2. .env file (SAP_USER + SAP_PASSWORD — never commit)\n\n' +
    '  3. Environment variables SAP_USER + SAP_PASSWORD'
  )
}

module.exports = { loadCredentials }
