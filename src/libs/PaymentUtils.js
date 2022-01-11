import _ from 'underscore';
import lodashGet from 'lodash/get';
import BankAccount from './models/BankAccount';
import * as Expensicons from '../components/Icon/Expensicons';
import getBankIcon from '../components/Icon/BankIcons';
import CONST from '../CONST';
import * as Localize from './Localize';

/**
 * Check to see if user has either a debit card or personal bank account added
 *
 * @param {Array} [cardList]
 * @param {Array} [bankAccountList]
 * @returns {Boolean}
 */
function hasExpensifyPaymentMethod(cardList = [], bankAccountList = []) {
    return _.some(cardList, card => card) || _.some(bankAccountList, (bankAccountJSON) => {
        const bankAccount = new BankAccount(bankAccountJSON);
        return bankAccount.isDefaultCredit();
    });
}

/**
 * Get the PaymentMethods list
 * @param {Array} bankAccountList
 * @param {Array} cardList
 * @param {String} [payPalMeUsername='']
 * @param {Object} userWallet
 * @returns {Array<PaymentMethod>}
 */
function getPaymentMethods(bankAccountList, cardList, payPalMeUsername = '', userWallet) {
    const combinedPaymentMethods = [];

    _.each(bankAccountList, (bankAccount) => {
        // Add all bank accounts besides the wallet
        if (bankAccount.type === CONST.BANK_ACCOUNT_TYPES.WALLET) {
            return;
        }

        const formattedBankAccountNumber = bankAccount.accountNumber
            ? `${Localize.translateLocal('paymentMethodList.accountLastFour')} ${bankAccount.accountNumber.slice(-4)
            }`
            : null;
        const isDefault = userWallet.walletLinkedAccountType === CONST.PAYMENT_METHODS.BANK_ACCOUNT && userWallet.walletLinkedAccountID === bankAccount.bankAccountID;
        const {icon, iconSize} = getBankIcon(lodashGet(bankAccount, 'additionalData.bankName', ''));
        combinedPaymentMethods.push({
            title: bankAccount.addressName,
            description: formattedBankAccountNumber,
            methodID: bankAccount.bankAccountID,
            icon,
            iconSize,
            key: `bankAccount-${bankAccount.bankAccountID}`,
            accountType: CONST.PAYMENT_METHODS.BANK_ACCOUNT,
            accountData: bankAccount,
            isDefault,
        });
    });

    _.each(cardList, (card) => {
        const formattedCardNumber = card.cardNumber
            ? `${Localize.translateLocal('paymentMethodList.cardLastFour')} ${card.cardNumber.slice(-4)}`
            : null;
        const isDefault = userWallet.walletLinkedAccountType === CONST.PAYMENT_METHODS.DEBIT_CARD && userWallet.walletLinkedAccountID === card.fundID;
        const {icon, iconSize} = getBankIcon(card.bank, true);
        combinedPaymentMethods.push({
            title: card.addressName,
            description: formattedCardNumber,
            methodID: card.cardNumber,
            icon,
            iconSize,
            key: `card-${card.cardNumber}`,
            accountType: CONST.PAYMENT_METHODS.DEBIT_CARD,
            accountData: card,
            isDefault,
        });
    });

    if (payPalMeUsername) {
        combinedPaymentMethods.push({
            title: 'PayPal.me',
            methodID: CONST.PAYMENT_METHODS.PAYPAL,
            description: payPalMeUsername,
            icon: Expensicons.PayPal,
            key: 'payPalMePaymentMethod',
            accountType: CONST.PAYMENT_METHODS.PAYPAL,
            accountData: {
                username: payPalMeUsername,
            },
        });
    }

    return combinedPaymentMethods;
}

export {
    hasExpensifyPaymentMethod,
    getPaymentMethods,
};
