import EventEmitter from 'events'
import { forwardEvent } from '@zap/utils/events'

/**
 * Base class for backup services that use tokens
 *
 * @export
 * @class TokenBasedBackupService
 * @extends {EventEmitter}
 */
export default class TokenBasedBackupService extends EventEmitter {
  // backup service connection. represents concrete service API (such as dropbox or google drive)
  connection = null

  /**
   * Initializes backup service connection and registers token listeners
   *
   * @param {Function} createClient function that instantiates `connection` object
   * @memberof TokenBasedBackupService
   */
  async init(createClient) {
    const { connection } = this
    if (!connection) {
      this.connection = await createClient()
      forwardEvent(this.connection, 'tokensReceived', this)
    }
  }

  /**
   * Cleans up current login. Should be called as a cleanup or before calling `init` with another credentials
   *
   * @memberof BackupService
   */
  async terminate() {
    const { connection } = this
    connection && connection.removeAllListeners('tokensReceived')
    this.connection = null
  }

  /**
   * Checks if client is setup for interactions. Also tests tokens for validity
   *
   * @returns {boolean} whether service is currently connected
   * @memberof BackupService
   */
  async isLoggedIn() {
    const { connection } = this
    return Boolean(connection && (await connection.testConnection()))
  }

  /**
   * Loads backup for the specified wallet
   *
   * @param {string} fileId
   * @returns {Buffer} wallet backup as a `Buffer`
   * @memberof BackupService
   */
  async loadBackup(fileId) {
    const { connection } = this
    if (connection) {
      const backup = await connection.downloadToBuffer(fileId)
      return backup
    }
    return null
  }

  /**
   * Returns current access tokens
   *
   * @returns {object} current tokens object or null if not logged in
   * @memberof BackupService
   */
  getTokens() {
    const { connection } = this
    return connection && connection.getTokens()
  }

  /**
   * This service is token based and requires tokens to operate
   * It also emits `tokensReceived` event
   *
   * @readonly
   * @memberof TokenBasedBackupService
   */
  get isUsingTokens() {
    return true
  }
}
