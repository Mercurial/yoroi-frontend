// @flow
import React, { Component } from 'react';
import { observer } from 'mobx-react';
import classnames from 'classnames';
import { defineMessages, intlShape } from 'react-intl';
import SvgInline from 'react-svg-inline';

import globalMessages from '../../../../i18n/global-messages';
import LocalizableError from '../../../../i18n/LocalizableError';

import Dialog from '../../../widgets/Dialog';
import DialogCloseButton from '../../../widgets/DialogCloseButton';

import ErrorBlock from '../../../widgets/ErrorBlock';

import styles from './ExportTxDialog.scss';

const messages = defineMessages({
  dialogTitle: {
    id: 'wallet.transaction.export.dialog.title',
    defaultMessage: '!!!Export transactions to file',
    description: 'Dialog title'
  },
  infoText1: {
    id: 'wallet.transaction.export.dialog.infoText1',
    defaultMessage: '!!!The entire transaction history within your wallet will be exported to a file',
    description: 'info text about entire transaction history export'
  },
  exportButtonLabel: {
    id: 'wallet.transaction.export.dialog.exportButton.label',
    defaultMessage: '!!!Export',
    description: '"Export" button label'
  }
});

type Props = {
  isActionProcessing?: boolean,
  error?: ?LocalizableError,
  submit?: Function,
  cancel: Function,
};

@observer
export default class ExportTxDialog extends Component<Props> {

  static contextTypes = {
    intl: intlShape.isRequired
  };

  render() {
    const { intl } = this.context;
    const {
      isActionProcessing,
      error,
      submit,
      cancel
    } = this.props;

    const introBlock = (
      <div>
        <span>{intl.formatMessage(messages.infoText1)}</span>
      </div>);

    const dailogActions = [{
      className: isActionProcessing ? styles.processing : null,
      label: intl.formatMessage(messages.exportButtonLabel),
      primary: true,
      disabled: false,
      onClick: submit,
    }];

    return (
      <Dialog
        className={classnames([styles.component, 'ExportTxDialog'])}
        title={intl.formatMessage(messages.dialogTitle)}
        actions={dailogActions}
        closeOnOverlayClick={false}
        closeButton={<DialogCloseButton />}
        onClose={cancel}
      >
        {introBlock}
        <ErrorBlock error={error} />
      </Dialog>);
  }
}
