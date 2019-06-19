import set from 'lodash/set'
import { send } from 'redux-electron-ipc'
import { grpcService } from 'workers'
import { isSCBRestoreEnabled } from '@zap/utils/featureFlag'
import { walletSelectors } from './wallet'
import { infoSelectors } from './info'
import { showError, showNotification } from './notification'

const SET_PROVIDER = 'SET_PROVIDER'
const SET_LOCAL_PATH = 'SET_LOCAL_PATH'
const SET_RESTORE_MODE = 'SET_RESTORE_MODE'

const RESTORE_STATE_STARTED = 'started'
const RESTORE_STATE_COMPLETE = 'complete'
const RESTORE_STATE_ERROR = 'error'

const dbGet = async walletId => {
  const wallet = await window.db.wallets.get(walletId)
  return wallet && wallet.backup
}

/**
 * Convenience wrapper that tries to update existing DB record and if fails insert new one
 *
 * @param {string} walletId
 * @param {object} update
 */
const dbUpdate = async (walletId, update) => {
  return await window.db.wallets.update(walletId, { backup: update })
}

const dbTransaction = operation => {
  return window.db.transaction('rw', window.db.wallets, operation)
}

/**
 * IPC callback for backup service tokens update event
 *
 * @export
 * @param {*} event
 * @param {*} { provider, tokens, walletId }
 */
export function backupTokensUpdated(event, { provider, tokens, walletId }) {
  return async () => {
    await dbTransaction(async () => {
      const backupDesc = (await dbGet(walletId)) || {}
      set(backupDesc, [provider, 'tokens'], tokens)
      await dbUpdate(walletId, backupDesc)
    })
  }
}

/**
 * Sets backup related properties into DB and initializes backup service
 * Should be used once per `walletId` during wallet lifetime
 * to prepare backup service for the operation
 * Once backup is setup, `initBackupService` should be used in subsequent sessions
 * to launch the service
 *
 * @export
 * @param {string} walletId
 * @returns
 */
export function setupBackupService(walletId, isRestoreMode) {
  return async (dispatch, getState) => {
    const { providerSelector, localPathSelector } = backupSelectors
    const provider = providerSelector(getState())
    const isLocalStrategy = provider === 'local'

    if (isRestoreMode) {
      await setRestoreState(walletId, RESTORE_STATE_STARTED)
    }

    await updateBackupProvider(walletId, provider)
    if (isLocalStrategy) {
      const dir = localPathSelector(getState())
      // we have backup dir setup in redux, use it to initialize db backup setup
      if (dir) {
        updateBackupId({ provider, backupId: dir, walletId })
        dispatch(setBackupPathLocal(null))
      }
    }

    dispatch(initBackupService(walletId, false))
  }
}

/**
 * canBackup - Checks if we are allowed to update existing backups.
 *
 * @param {string} walletId
 * @returns {boolean}
 */
async function canBackup(walletId) {
  const backupDesc = (await dbGet(walletId)) || {}
  const { channelsRestoreState } = backupDesc
  return !channelsRestoreState || channelsRestoreState === RESTORE_STATE_COMPLETE
}

/**
 * setRestoreState - Sets current restore state.
 *
 * @param {string} walletId
 * @param {(RESTORE_STATE_STARTED|RESTORE_STATE_COMPLETE|RESTORE_STATE_ERROR)} state
 * @returns {Promise}
 */
async function setRestoreState(walletId, state) {
  return await dbTransaction(async () => {
    const backupDesc = (await dbGet(walletId)) || {}
    backupDesc.channelsRestoreState = state
    return await dbUpdate(walletId, backupDesc)
  })
}

/**
 * initBackupService - Initializes backup service for the specified wallet. Backup provider must be either set in db
 * or in `state.backup.provider` before calling this routine.
 *
 * @export
 * @param {string} walletId - wallet identifier. if not specified uses current active wallet
 * @param {boolean}  forceUseTokens - if true only initializes service if it was previously set up
 * and has tokens stored
 * @returns {Function}
 */
export function initBackupService(walletId, forceUseTokens = false) {
  return async (dispatch, getState) => {
    const { providerSelector } = backupSelectors
    const wId = walletId || walletSelectors.activeWallet(getState())
    const isLocalStrategy = () => providerSelector(getState()) === 'local'

    // returns backup service startup params based on serialized data availability
    const getServiceParams = async () => {
      const backupDesc = await dbGet(wId)
      // attempt to initialize backup service with stored tokens
      if (backupDesc) {
        const { activeProviders, channelsRestoreState } = backupDesc
        const [firstProvider] = activeProviders
        // resume restore mode if it's pending
        dispatch(setRestoreMode(channelsRestoreState === RESTORE_STATE_STARTED))
        await dispatch(setBackupProvider(firstProvider))
        const { tokens } = backupDesc[firstProvider] || {}
        return { walletId: wId, tokens, provider: firstProvider }
      }

      return { walletId: wId, provider: providerSelector(getState()) }
    }
    const params = await getServiceParams()
    // do not initialize service if no tokens are available and forceUseToken is enabled
    // this allows to skip backup service initialization for wallets that don't have backup process
    // set up previously
    if (!isLocalStrategy() && !params.tokens && forceUseTokens) {
      return
    }

    return dispatch(send('initBackupService', params))
  }
}

/**
 * backupCurrentWallet - Backs up current active wallet
 */
export const backupCurrentWallet = (walletId, backup) => async (dispatch, getState) => {
  const getFreshBackup = async () => {
    const grpc = await grpcService
    if (await grpc.services.Lightning.hasMethod('exportAllChannelBackups')) {
      return await grpc.services.Lightning.exportAllChannelBackups({})
    }
    return null
  }

  // returns binary representation of channel backups as a buffer
  const getBackupBuff = backupData =>
    backupData && backupData.multi_chan_backup && backupData.multi_chan_backup.multi_chan_backup

  try {
    const state = getState()
    // there is no current active wallet
    if (!walletId || !canBackup(walletId)) {
      return
    }
    const nodePub = infoSelectors.nodePubkey(state)
    const { activeProviders, ...rest } = (await dbGet(walletId)) || {}
    if (activeProviders) {
      const [firstProvider] = activeProviders
      const backupData = backup || (await getFreshBackup())
      if (backupData && firstProvider) {
        const backupMetadata = rest[firstProvider]
        dispatch(
          send('saveBackup', {
            backup: getBackupBuff(backupData),
            walletId,
            backupMetadata,
            nodePub,
            provider: firstProvider,
          })
        )
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(e)
    // TODO: add notification that backup has failed and user attention may be required
  }
}

/**
 * saveBackupSuccess - IPC callback for successful backup.
 */
export const saveBackupSuccess = (event, { provider, backupId, walletId }) => async () => {
  await updateBackupId({ provider, backupId, walletId })
}

/**
 * updateBackupId - updates wallets' backupID in the DB.
 */
export const updateBackupId = async ({ provider, backupId, walletId }) => {
  await dbTransaction(async () => {
    const backupDesc = (await dbGet(walletId)) || {}
    set(backupDesc, [provider, 'backupId'], backupId)
    await dbUpdate(walletId, backupDesc)
  })
}

/**
 * backupServiceInitialized - IPC callback for backup service being ready.
 */
export const backupServiceInitialized = (event, { walletId }) => async (dispatch, getState) => {
  const state = getState()
  const isRestoreMode = backupSelectors.restoreModeSelector(state)
  // service is in restore mode
  if (isRestoreMode) {
    dispatch(queryWalletBackup(walletId, backupSelectors.providerSelector(state)))
  } else {
    dispatch(backupCurrentWallet(walletId))
  }
}

/**
 * updateBackupProvider - updates wallets' backup provider in the DB.
 */
async function updateBackupProvider(walletId, provider) {
  await dbTransaction(async () => {
    const backupDesc = (await dbGet(walletId)) || {}
    const { activeProviders = [] } = backupDesc

    if (!activeProviders.includes(provider)) {
      backupDesc.activeProviders = [...activeProviders, provider]
    }

    await dbUpdate(walletId, backupDesc)
  })
}

/**
 * setBackupProvider - sets current backup provider.
 *
 * @param {('gdrive'|'local'|'dropbox')} provider  backup service provider to be used in `initBackupService` call
 */
export const setBackupProvider = provider => {
  return {
    type: SET_PROVIDER,
    provider,
  }
}

/**
 * setBackupPathLocal - sets backup path for the local strategy.
 *
 * @param {string} localPath local filesystem directory URI
 */
export const setBackupPathLocal = localPath => {
  return {
    type: SET_LOCAL_PATH,
    localPath,
  }
}
/**
 * setRestoreMode - turns restore mode on/off.
 *
 * @param {boolean} value true if restore mode is active
 */
export const setRestoreMode = value => {
  return {
    type: SET_RESTORE_MODE,
    value: isSCBRestoreEnabled() && value,
  }
}

export const queryWalletBackup = (walletId, provider) => async (dispatch, getState) => {
  const backupDesc = (await dbGet(walletId)) || {}
  if (backupDesc[provider]) {
    const state = getState()
    const nodePub = infoSelectors.nodePubkey(state)
    const { backupId } = backupDesc[provider]
    dispatch(send('queryBackup', { walletId, backupId, nodePub, provider }))
  }
}

export const queryWalletBackupSuccess = (event, { walletId, backup }) => async dispatch => {
  try {
    dispatch(restoreWallet(backup))
    await setRestoreState(walletId, RESTORE_STATE_COMPLETE)
  } catch (e) {
    await setRestoreState(walletId, RESTORE_STATE_ERROR)
  }
}
export const queryWalletBackupFailure = () => async dispatch => {
  // TODO add intl support
  dispatch(showError(`Unable to find backup file`))
}

export const restoreWallet = backup => async dispatch => {
  try {
    const grpc = await grpcService
    const result = await grpc.services.Lightning.restoreChannelBackups({
      multi_chan_backup: backup,
    })
    // TODO add intl support
    dispatch(showNotification(`Wallet backup imported successfully`))
    return result
  } catch (e) {
    dispatch(showError(`Backup import has failed: ${e.message}`))
  }
}

const ACTION_HANDLERS = {
  [SET_PROVIDER]: (state, { provider }) => ({
    ...state,
    provider,
  }),
  [SET_LOCAL_PATH]: (state, { localPath }) => ({
    ...state,
    localPath,
  }),
  [SET_RESTORE_MODE]: (state, { value }) => ({
    ...state,
    isRestoreMode: value,
  }),
}

const initialState = {
  provider: null,
  isRestoreMode: false,
}

// Selectors
const backupSelectors = {}
backupSelectors.providerSelector = state => state.backup.provider
backupSelectors.localPathSelector = state => state.backup.localPath
backupSelectors.restoreModeSelector = state => state.backup.isRestoreMode

export { backupSelectors }

export default function backupReducer(state = initialState, action) {
  const handler = ACTION_HANDLERS[action.type]

  return handler ? handler(state, action) : state
}
