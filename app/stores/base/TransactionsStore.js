// @flow
import { observable, computed, action, extendObservable } from 'mobx';
import _ from 'lodash';
import BigNumber from 'bignumber.js';
import Store from './Store';
import CachedRequest from '../lib/LocalizedCachedRequest';
import LocalizedRequest from '../lib/LocalizedRequest';
import WalletTransaction from '../../domain/WalletTransaction';
import type {
  GetTransactionsResponse,
  GetBalanceResponse,
  GetTransactionsRequest,
  GetTransactionsRequesOptions,
  GetTransactionRowsToExportRequest,
  GetTransactionRowsToExportResponse,
  ExportTransactionsRequest,
  ExportTransactionsResponse,
} from '../../api/common';
import environment from '../../environment';
import {
  Logger,
  stringifyError
} from '../../utils/logging';
import LocalizableError from '../../i18n/LocalizableError';
import { UnexpectedError } from '../../i18n/LocalizableError';
import globalMessages from '../../i18n/global-messages';

export default class TransactionsStore extends Store {

  /** How many transactions to display */
  INITIAL_SEARCH_LIMIT = 5;

  /** How many additonall transactions to display when user wants to show more */
  SEARCH_LIMIT_INCREASE = 5;

  /** Skip first n transactions from api */
  SEARCH_SKIP = 0;

  /** Track transactions for a set of wallets */
  @observable transactionsRequests: Array<{
    walletId: string,
    pendingRequest: CachedRequest<GetTransactionsResponse>,
    recentRequest: CachedRequest<GetTransactionsResponse>,
    allRequest: CachedRequest<GetTransactionsResponse>,
    getBalanceRequest: CachedRequest<GetBalanceResponse>
  }> = [];

  @observable _searchOptionsForWallets = {};

  getTransactionRowsToExportRequest: LocalizedRequest<GetTransactionRowsToExportResponse>
    = new LocalizedRequest(this.api.ada.getTransactionRowsToExport);

  exportTransactions: LocalizedRequest<ExportTransactionsResponse>
    = new LocalizedRequest(this.api.export.exportTransactions);

  @observable isExporting: boolean = false;

  @observable exportError: ?LocalizableError;

  _hasAnyPending: boolean = false;

  setup() {
    const actions = this.actions[environment.API].transactions;
    actions.loadMoreTransactions.listen(this._increaseSearchLimit);
    actions.exportTransactionsToFile.listen(this._exportTransactionsToFile);
    actions.closeExportTransactionDialog.listen(this._closeExportTransactionDialog);
  }

  @action _increaseSearchLimit = () => {
    if (this.searchOptions != null) {
      this.searchOptions.limit += this.SEARCH_LIMIT_INCREASE;
      this._refreshTransactionData();
    }
  };

  @computed get recentTransactionsRequest(): CachedRequest<GetTransactionsResponse> {
    const wallet = this.stores.substores[environment.API].wallets.active;
    // TODO: Do not return new request here
    if (!wallet) return new CachedRequest(this.api[environment.API].refreshTransactions);
    return this._getTransactionsRecentRequest(wallet.id);
  }

  /** Get (or create) the search options for the active wallet (if any)  */
  @computed get searchOptions(): ?GetTransactionsRequesOptions {
    const wallet = this.stores.substores[environment.API].wallets.active;
    if (!wallet) return null;
    let options = this._searchOptionsForWallets[wallet.id];
    if (!options) {
      // Setup options for each requested wallet
      extendObservable(this._searchOptionsForWallets, {
        [wallet.id]: {
          limit: this.INITIAL_SEARCH_LIMIT,
          skip: this.SEARCH_SKIP
        }
      });
      options = this._searchOptionsForWallets[wallet.id];
    }
    return options;
  }

  @computed get recent(): Array<WalletTransaction> {
    const wallet = this.stores.substores[environment.API].wallets.active;
    if (!wallet) return [];
    const result = this._getTransactionsRecentRequest(wallet.id).result;
    return result ? result.transactions : [];
  }

  @computed get hasAny(): boolean {
    const wallet = this.stores.substores[environment.API].wallets.active;
    if (!wallet) return false;
    const result = this._getTransactionsRecentRequest(wallet.id).result;
    return result ? result.transactions.length > 0 : false;
  }

  @computed get hasAnyPending(): boolean {
    const wallet = this.stores.substores[environment.API].wallets.active;
    if (!wallet) return false;
    const result = this._getTransactionsPendingRequest(wallet.id).result;
    if (result) {
      this._hasAnyPending = result.length > 0;
    }
    return this._hasAnyPending;
  }

  @computed get totalAvailable(): number {
    const wallet = this.stores.substores[environment.API].wallets.active;
    if (!wallet) return 0;
    const result = this._getTransactionsAllRequest(wallet.id).result;
    return result ? result.transactions.length : 0;
  }

  /** Refresh transaction data for all wallets and update wallet balance */
  @action _refreshTransactionData = () => {
    const walletsStore = this.stores.substores[environment.API].wallets;
    const walletsActions = this.actions[environment.API].wallets;
    const allWallets = walletsStore.all;
    for (const wallet of allWallets) {
      // Create transactions request for recent transactions
      const limit = this.searchOptions
        ? this.searchOptions.limit
        : this.INITIAL_SEARCH_LIMIT;
      const skip = this.searchOptions
        ? this.searchOptions.skip
        : this.SEARCH_SKIP;
      const requestParams: GetTransactionsRequest = {
        walletId: wallet.id,
        limit,
        skip,
      };
      const recentRequest = this._getTransactionsRecentRequest(wallet.id);
      recentRequest.invalidate({ immediately: false });
      recentRequest.execute(requestParams); // note: different params/cache than allRequests

      const allRequest = this._getTransactionsAllRequest(wallet.id);
      allRequest.invalidate({ immediately: false });
      allRequest.execute({ walletId: wallet.id });

      allRequest.promise
        .then(async () => {
          // calculate pending tranactions just to cache the result
          const pendingRequest = this._getTransactionsPendingRequest(wallet.id);
          pendingRequest.invalidate({ immediately: false });
          pendingRequest.execute({ walletId: wallet.id });

          const lastUpdateDate = await this.api[environment.API].getTxLastUpdatedDate();
          // Note: cache based on lastUpdateDate even though it's not used in balanceRequest
          return this._getBalanceRequest(wallet.id).execute(lastUpdateDate);
        })
        .then((updatedBalance: BigNumber) => {
          if (walletsStore.active && walletsStore.active.id === wallet.id) {
            walletsActions.updateBalance.trigger(updatedBalance);
          }
          return undefined;
        })
        .catch(() => {}); // Do nothing. It's logged in the api call
    }
  };

  /** Update which walletIds to track and refresh the data */
  @action updateObservedWallets = (
    walletIds: Array<string>
  ): void => {
    this.transactionsRequests = walletIds.map(walletId => ({
      walletId,
      recentRequest: this._getTransactionsRecentRequest(walletId),
      allRequest: this._getTransactionsAllRequest(walletId),
      getBalanceRequest: this._getBalanceRequest(walletId),
      pendingRequest: this._getTransactionsPendingRequest(walletId),
    }));
    this._refreshTransactionData();
  }

  _getTransactionsPendingRequest = (walletId: string): CachedRequest<GetTransactionsResponse> => {
    const foundRequest = _.find(this.transactionsRequests, { walletId });
    if (foundRequest && foundRequest.pendingRequest) return foundRequest.pendingRequest;
    return new CachedRequest(this.api[environment.API].refreshPendingTransactions);
  };

  /** Get request for fetching transaction data.
   * Should ONLY be executed to cache query WITH search options */
  _getTransactionsRecentRequest = (walletId: string): CachedRequest<GetTransactionsResponse> => {
    const foundRequest = _.find(this.transactionsRequests, { walletId });
    if (foundRequest && foundRequest.recentRequest) return foundRequest.recentRequest;
    return new CachedRequest(this.api[environment.API].refreshTransactions);
  };

  /** Get request for fetching transaction data.
   * Should ONLY be executed to cache query WITHOUT search options */
  _getTransactionsAllRequest = (walletId: string): CachedRequest<GetTransactionsResponse> => {
    const foundRequest = _.find(this.transactionsRequests, { walletId });
    if (foundRequest && foundRequest.allRequest) return foundRequest.allRequest;
    return new CachedRequest(this.api[environment.API].refreshTransactions);
  };

  _getBalanceRequest = (walletId: string): CachedRequest<GetBalanceResponse> => {
    const foundRequest = _.find(this.transactionsRequests, { walletId });
    if (foundRequest && foundRequest.getBalanceRequest) return foundRequest.getBalanceRequest;
    return new CachedRequest(this.api[environment.API].getBalance);
  };

  @action _exportTransactionsToFile = async (
    params: GetTransactionRowsToExportRequest
  ): Promise<void> => {
    try {
      this._setExporting(true);
      // TODO: Logging
      this.getTransactionRowsToExportRequest.reset();
      this.exportTransactions.reset();

      const respTxRows: GetTransactionRowsToExportResponse =
        await this.getTransactionRowsToExportRequest.execute(params).promise;

      if(respTxRows == null || respTxRows.length < 1) {
        throw new LocalizableError(globalMessages.noTransactionsFound);
      }

      setTimeout(async () => {
        const req: ExportTransactionsRequest = {
          rows: respTxRows
        };
        await this.exportTransactions.execute(req).promise;
        this._setExporting(false);
        this.actions.dialogs.closeActiveDialog.trigger();
      }, 800);

    } catch (error) {
      let localizableError = error;
      if(!(error instanceof LocalizableError)) {
        localizableError = new UnexpectedError();
      }

      this._setExportError(localizableError);
      this._setExporting(false);
      Logger.error(`TransactionsStore::_exportTransactionsToFile ${stringifyError(error)}`);
    } finally {
      this.getTransactionRowsToExportRequest.reset();
      this.exportTransactions.reset();
    }
  }

  @action _setExporting = (isExporting: boolean): void  => {
    this.isExporting = isExporting;
  }

  @action _setExportError = (error: ?LocalizableError): void => {
    this.exportError = error;
  }

  @action _closeExportTransactionDialog = (): void => {
    if(!this.isExporting) {
      this.actions.dialogs.closeActiveDialog.trigger();
      this._setExporting(false);
      this._setExportError(null);
    }
  }
}
