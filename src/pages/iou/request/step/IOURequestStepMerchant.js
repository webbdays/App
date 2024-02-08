import lodashGet from 'lodash/get';
import lodashIsEmpty from 'lodash/isEmpty';
import React, {useCallback} from 'react';
import {View} from 'react-native';
import {withOnyx} from 'react-native-onyx';
import _ from 'underscore';
import FormProvider from '@components/Form/FormProvider';
import InputWrapper from '@components/Form/InputWrapper';
import TextInput from '@components/TextInput';
import transactionPropTypes from '@components/transactionPropTypes';
import useAutoFocusInput from '@hooks/useAutoFocusInput';
import useLocalize from '@hooks/useLocalize';
import useThemeStyles from '@hooks/useThemeStyles';
import compose from '@libs/compose';
import Navigation from '@libs/Navigation/Navigation';
import * as ReportUtils from '@libs/ReportUtils';
import * as IOU from '@userActions/IOU';
import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import ROUTES from '@src/ROUTES';
import IOURequestStepRoutePropTypes from './IOURequestStepRoutePropTypes';
import StepScreenWrapper from './StepScreenWrapper';
import withFullTransactionOrNotFound from './withFullTransactionOrNotFound';
import withWritableReportOrNotFound from './withWritableReportOrNotFound';

const propTypes = {
    /** Navigation route context info provided by react navigation */
    route: IOURequestStepRoutePropTypes.isRequired,

    /** Onyx Props */
    /** Holds data related to Money Request view state, rather than the underlying Money Request data. */
    transaction: transactionPropTypes,

    /** The draft transaction that holds data to be persisted on the current transaction */
    splitDraftTransaction: transactionPropTypes,
};

const defaultProps = {
    transaction: {},
    splitDraftTransaction: {},
};

function IOURequestStepMerchant({
    route: {
        params: {transactionID, reportID, backTo, action, iouType},
    },
    transaction,
    splitDraftTransaction,
}) {
    const styles = useThemeStyles();
    const {translate} = useLocalize();
    const {inputCallbackRef} = useAutoFocusInput();

    // In the split flow, when editing we use SPLIT_TRANSACTION_DRAFT to save draft value
    const isEditingSplitBill = iouType === CONST.IOU.TYPE.SPLIT && action === CONST.IOU.ACTION.EDIT;

    const {merchant} = ReportUtils.getTransactionDetails(isEditingSplitBill && !lodashIsEmpty(splitDraftTransaction) ? splitDraftTransaction : transaction);

    const isEmptyMerchant = merchant === '' || merchant === CONST.TRANSACTION.PARTIAL_TRANSACTION_MERCHANT;

    const isMerchantRequired = _.some(transaction.participants, (participant) => Boolean(participant.isPolicyExpenseChat));

    const navigateBack = () => {
        Navigation.goBack(backTo || ROUTES.HOME);
    };

    const isEditing = action === CONST.IOU.ACTION.EDIT;

    /**
     * @param {Object} value
     * @param {String} value.moneyRequestMerchant
     */
    const validate = useCallback(
        (value) => {
            const errors = {};

            if (isMerchantRequired && _.isEmpty(value.moneyRequestMerchant)) {
                errors.moneyRequestMerchant = 'common.error.fieldRequired';
            }

            return errors;
        },
        [isMerchantRequired],
    );

    /**
     * @param {Object} value
     * @param {String} value.moneyRequestMerchant
     */
    const updateMerchant = (value) => {
        const newMerchant = value.moneyRequestMerchant.trim();
        // In the split flow, when editing we use SPLIT_TRANSACTION_DRAFT to save draft value
        if (isEditingSplitBill) {
            IOU.setDraftSplitTransaction(transactionID, {merchant: newMerchant});
            navigateBack();
            return;
        }

        // In case the merchant hasn't been changed, do not make the API request.
        // In case the merchant has been set to empty string while current merchant is partial, do nothing too.
        if (newMerchant === merchant || (newMerchant === '' && merchant === CONST.TRANSACTION.PARTIAL_TRANSACTION_MERCHANT)) {
            navigateBack();
            return;
        }

        IOU.setMoneyRequestMerchant(transactionID, newMerchant, !isEditing);

        if (isEditing) {
            IOU.updateMoneyRequestMerchant(transactionID, reportID, newMerchant || CONST.TRANSACTION.PARTIAL_TRANSACTION_MERCHANT);
        }
        navigateBack();
    };

    return (
        <StepScreenWrapper
            headerTitle={translate('common.merchant')}
            onBackButtonPress={navigateBack}
            shouldShowWrapper
            testID={IOURequestStepMerchant.displayName}
        >
            <FormProvider
                style={[styles.flexGrow1, styles.ph5]}
                formID={ONYXKEYS.FORMS.MONEY_REQUEST_MERCHANT_FORM}
                onSubmit={updateMerchant}
                validate={validate}
                submitButtonText={translate('common.save')}
                enabledWhenOffline
            >
                <View style={styles.mb4}>
                    <InputWrapper
                        InputComponent={TextInput}
                        inputID="moneyRequestMerchant"
                        name="moneyRequestMerchant"
                        defaultValue={isEmptyMerchant ? '' : merchant}
                        maxLength={CONST.MERCHANT_NAME_MAX_LENGTH}
                        label={translate('common.merchant')}
                        accessibilityLabel={translate('common.merchant')}
                        role={CONST.ROLE.PRESENTATION}
                        ref={inputCallbackRef}
                    />
                </View>
            </FormProvider>
        </StepScreenWrapper>
    );
}

IOURequestStepMerchant.propTypes = propTypes;
IOURequestStepMerchant.defaultProps = defaultProps;
IOURequestStepMerchant.displayName = 'IOURequestStepMerchant';

export default compose(
    withWritableReportOrNotFound,
    withFullTransactionOrNotFound,
    withOnyx({
        splitDraftTransaction: {
            key: ({route}) => {
                const transactionID = lodashGet(route, 'params.transactionID', 0);
                return `${ONYXKEYS.COLLECTION.SPLIT_TRANSACTION_DRAFT}${transactionID}`;
            },
        },
    }),
)(IOURequestStepMerchant);
