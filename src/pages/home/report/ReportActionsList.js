import {useIsFocused, useRoute} from '@react-navigation/native';
import lodashGet from 'lodash/get';
import PropTypes from 'prop-types';
import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {DeviceEventEmitter, InteractionManager} from 'react-native';
import Animated, {useAnimatedStyle, useSharedValue, withTiming} from 'react-native-reanimated';
import _ from 'underscore';
import InvertedFlatList from '@components/InvertedFlatList';
import {usePersonalDetails} from '@components/OnyxProvider';
import withCurrentUserPersonalDetails, {withCurrentUserPersonalDetailsDefaultProps, withCurrentUserPersonalDetailsPropTypes} from '@components/withCurrentUserPersonalDetails';
import withWindowDimensions, {windowDimensionsPropTypes} from '@components/withWindowDimensions';
import useLocalize from '@hooks/useLocalize';
import useNetwork from '@hooks/useNetwork';
import useReportScrollManager from '@hooks/useReportScrollManager';
import useThemeStyles from '@hooks/useThemeStyles';
import compose from '@libs/compose';
import DateUtils from '@libs/DateUtils';
import * as ReportActionsUtils from '@libs/ReportActionsUtils';
import * as ReportUtils from '@libs/ReportUtils';
import Visibility from '@libs/Visibility';
import reportPropTypes from '@pages/reportPropTypes';
import variables from '@styles/variables';
import * as Report from '@userActions/Report';
import CONST from '@src/CONST';
import FloatingMessageCounter from './FloatingMessageCounter';
import ListBoundaryLoader from './ListBoundaryLoader/ListBoundaryLoader';
import reportActionPropTypes from './reportActionPropTypes';
import ReportActionsListItemRenderer from './ReportActionsListItemRenderer';

const propTypes = {
    /** The report currently being looked at */
    report: reportPropTypes.isRequired,

    /** The report's parentReportAction */
    parentReportAction: PropTypes.shape(reportActionPropTypes),

    /** Sorted actions prepared for display */
    sortedReportActions: PropTypes.arrayOf(PropTypes.shape(reportActionPropTypes)).isRequired,

    /** The ID of the most recent IOU report action connected with the shown report */
    mostRecentIOUReportActionID: PropTypes.string,

    /** The report metadata loading states */
    isLoadingInitialReportActions: PropTypes.bool,

    /** Are we loading more report actions? */
    isLoadingOlderReportActions: PropTypes.bool,

    /** Are we loading newer report actions? */
    isLoadingNewerReportActions: PropTypes.bool,

    /** Callback executed on list layout */
    onLayout: PropTypes.func.isRequired,

    /** Callback executed on scroll */
    onScroll: PropTypes.func,

    /** Function to load more chats */
    loadOlderChats: PropTypes.func.isRequired,

    /** Function to load newer chats */
    loadNewerChats: PropTypes.func.isRequired,

    /** The policy object for the current route */
    policy: PropTypes.shape({
        /** The name of the policy */
        name: PropTypes.string,

        /** The URL for the policy avatar */
        avatar: PropTypes.string,
    }),

    ...windowDimensionsPropTypes,
    ...withCurrentUserPersonalDetailsPropTypes,
};

const defaultProps = {
    onScroll: () => {},
    mostRecentIOUReportActionID: '',
    isLoadingInitialReportActions: false,
    isLoadingOlderReportActions: false,
    isLoadingNewerReportActions: false,
    ...withCurrentUserPersonalDetailsDefaultProps,
    policy: {},
    parentReportAction: {},
};

const VERTICAL_OFFSET_THRESHOLD = 200;
const MSG_VISIBLE_THRESHOLD = 250;

// In the component we are subscribing to the arrival of new actions.
// As there is the possibility that there are multiple instances of a ReportScreen
// for the same report, we only ever want one subscription to be active, as
// the subscriptions could otherwise be conflicting.
const newActionUnsubscribeMap = {};

// Caching the reportID and reportActionID for unread markers ensures persistent tracking
// across multiple reports, preserving the green line placement and allowing retrieval
// of the relevant reportActionID for displaying the green line.
// We need to persist it across reports because there are at least 3 ReportScreen components created so the
// internal states are resetted or recreated.
const cacheUnreadMarkers = new Map();

// Seems that there is an architecture issue that prevents us from using the reportID with useRef
// the useRef value gets reset when the reportID changes, so we use a global variable to keep track
let prevReportID = null;

/**
 * Create a unique key for each action in the FlatList.
 * We use the reportActionID that is a string representation of a random 64-bit int, which should be
 * random enough to avoid collisions
 * @param {Object} item
 * @param {Object} item.action
 * @return {String}
 */
function keyExtractor(item) {
    return item.reportActionID;
}

function isMessageUnread(message, lastReadTime) {
    if (!lastReadTime) {
        return Boolean(!ReportActionsUtils.isCreatedAction(message));
    }

    return Boolean(message && lastReadTime && message.created && lastReadTime < message.created);
}

const onScrollToIndexFailed = () => {};

function ReportActionsList({
    report,
    parentReportAction,
    isLoadingInitialReportActions,
    isLoadingOlderReportActions,
    isLoadingNewerReportActions,
    sortedReportActions,
    windowHeight,
    onScroll,
    mostRecentIOUReportActionID,
    isSmallScreenWidth,
    currentUserPersonalDetails,
    loadNewerChats,
    loadOlderChats,
    onLayout,
    isComposerFullSize,
}) {
    const personalDetailsList = usePersonalDetails() || CONST.EMPTY_OBJECT;
    const styles = useThemeStyles();
    const {translate} = useLocalize();
    const {isOffline} = useNetwork();
    const route = useRoute();
    const opacity = useSharedValue(0);
    const userActiveSince = useRef(null);
    const lastMessageTime = useRef(null);

    const [isVisible, setIsVisible] = useState(false);
    const isFocused = useIsFocused();

    useEffect(() => {
        const unsubscriber = Visibility.onVisibilityChange(() => {
            setIsVisible(Visibility.isVisible());
        });

        return unsubscriber;
    }, []);

    const markerInit = () => {
        if (!cacheUnreadMarkers.has(report.reportID)) {
            return null;
        }
        return cacheUnreadMarkers.get(report.reportID);
    };
    const reportScrollManager = useReportScrollManager();
    const [currentUnreadMarker, setCurrentUnreadMarker] = useState(markerInit);
    const scrollingVerticalOffset = useRef(0);
    const readActionSkipped = useRef(false);
    const hasHeaderRendered = useRef(false);
    const hasFooterRendered = useRef(false);
    const lastVisibleActionCreatedRef = useRef(report.lastVisibleActionCreated);
    const lastReadTimeRef = useRef(report.lastReadTime);

    const sortedVisibleReportActions = useMemo(
        () => _.filter(sortedReportActions, (s) => isOffline || s.pendingAction !== CONST.RED_BRICK_ROAD_PENDING_ACTION.DELETE || s.errors),
        [sortedReportActions, isOffline],
    );
    const lastActionIndex = lodashGet(sortedVisibleReportActions, [0, 'reportActionID']);
    const reportActionSize = useRef(sortedVisibleReportActions.length);

    const previousLastIndex = useRef(lastActionIndex);

    const linkedReportActionID = lodashGet(route, 'params.reportActionID', '');

    // This state is used to force a re-render when the user manually marks a message as unread
    // by using a timestamp you can force re-renders without having to worry about if another message was marked as unread before
    const [messageManuallyMarkedUnread, setMessageManuallyMarkedUnread] = useState(0);
    const [isFloatingMessageCounterVisible, setIsFloatingMessageCounterVisible] = useState(false);
    const animatedStyles = useAnimatedStyle(() => ({
        opacity: opacity.value,
    }));

    useEffect(() => {
        opacity.value = withTiming(1, {duration: 100});
    }, [opacity]);

    useEffect(() => {
        if (previousLastIndex.current !== lastActionIndex && reportActionSize.current > sortedVisibleReportActions.length) {
            reportScrollManager.scrollToBottom();
        }
        previousLastIndex.current = lastActionIndex;
        reportActionSize.current = sortedVisibleReportActions.length;
    }, [lastActionIndex, sortedVisibleReportActions.length, reportScrollManager]);

    useEffect(() => {
        // If the reportID changes, we reset the userActiveSince to null, we need to do it because
        // the parent component is sending the previous reportID even when the user isn't active
        // on the report
        if (userActiveSince.current && prevReportID && prevReportID !== report.reportID) {
            userActiveSince.current = null;
        } else {
            userActiveSince.current = DateUtils.getDBTime();
        }
        prevReportID = report.reportID;
    }, [report.reportID]);

    useEffect(() => {
        if (!userActiveSince.current || report.reportID !== prevReportID) {
            return;
        }

        if (ReportUtils.isUnread(report)) {
            if (Visibility.isVisible() && scrollingVerticalOffset.current < MSG_VISIBLE_THRESHOLD) {
                Report.readNewestAction(report.reportID);
            } else {
                readActionSkipped.current = true;
            }
        }

        if (currentUnreadMarker || lastVisibleActionCreatedRef.current === report.lastVisibleActionCreated) {
            return;
        }

        cacheUnreadMarkers.delete(report.reportID);
        lastVisibleActionCreatedRef.current = report.lastVisibleActionCreated;
        setCurrentUnreadMarker(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [report.lastVisibleActionCreated, report.reportID]);

    useEffect(() => {
        if (!userActiveSince.current || report.reportID !== prevReportID) {
            return;
        }
        if (!messageManuallyMarkedUnread && (lastReadTimeRef.current || '') < report.lastReadTime) {
            cacheUnreadMarkers.delete(report.reportID);
        }
        lastReadTimeRef.current = report.lastReadTime;
        setMessageManuallyMarkedUnread(0);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [report.lastReadTime, report.reportID]);

    useEffect(() => {
        const resetUnreadMarker = (newLastReadTime) => {
            cacheUnreadMarkers.delete(report.reportID);
            lastReadTimeRef.current = newLastReadTime;
            setCurrentUnreadMarker(null);
        };

        const unreadActionSubscription = DeviceEventEmitter.addListener(`unreadAction_${report.reportID}`, (newLastReadTime) => {
            resetUnreadMarker(newLastReadTime);
            setMessageManuallyMarkedUnread(new Date().getTime());
        });

        const readNewestActionSubscription = DeviceEventEmitter.addListener(`readNewestAction_${report.reportID}`, (newLastReadTime) => {
            resetUnreadMarker(newLastReadTime);
            setMessageManuallyMarkedUnread(0);
        });

        return () => {
            unreadActionSubscription.remove();
            readNewestActionSubscription.remove();
        };
    }, [report.reportID]);

    useEffect(() => {
        InteractionManager.runAfterInteractions(() => {
            reportScrollManager.scrollToBottom();
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        // Why are we doing this, when in the cleanup of the useEffect we are already calling the unsubscribe function?
        // Answer: On web, when navigating to another report screen, the previous report screen doesn't get unmounted,
        //         meaning that the cleanup might not get called. When we then open a report we had open already previosuly, a new
        //         ReportScreen will get created. Thus, we have to cancel the earlier subscription of the previous screen,
        //         because the two subscriptions could conflict!
        //         In case we return to the previous screen (e.g. by web back navigation) the useEffect for that screen would
        //         fire again, as the focus has changed and will set up the subscription correctly again.
        const previousSubUnsubscribe = newActionUnsubscribeMap[report.reportID];
        if (previousSubUnsubscribe) {
            previousSubUnsubscribe();
        }

        // This callback is triggered when a new action arrives via Pusher and the event is emitted from Report.js. This allows us to maintain
        // a single source of truth for the "new action" event instead of trying to derive that a new action has appeared from looking at props.
        const unsubscribe = Report.subscribeToNewActionEvent(report.reportID, (isFromCurrentUser) => {
            // If a new comment is added and it's from the current user scroll to the bottom otherwise leave the user positioned where
            // they are now in the list.
            if (!isFromCurrentUser) {
                return;
            }
            InteractionManager.runAfterInteractions(() => reportScrollManager.scrollToBottom());
        });

        const cleanup = () => {
            if (unsubscribe) {
                unsubscribe();
            }
            InteractionManager.runAfterInteractions(() => {
                Report.unsubscribeFromReportChannel(report.reportID);
            });
        };

        newActionUnsubscribeMap[report.reportID] = cleanup;

        return cleanup;

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [report.reportID]);

    /**
     * Show/hide the new floating message counter when user is scrolling back/forth in the history of messages.
     */
    const handleUnreadFloatingButton = () => {
        if (scrollingVerticalOffset.current > VERTICAL_OFFSET_THRESHOLD && !isFloatingMessageCounterVisible && !!currentUnreadMarker) {
            setIsFloatingMessageCounterVisible(true);
        }

        if (scrollingVerticalOffset.current < VERTICAL_OFFSET_THRESHOLD && isFloatingMessageCounterVisible) {
            if (readActionSkipped.current) {
                readActionSkipped.current = false;
                Report.readNewestAction(report.reportID);
            }
            setIsFloatingMessageCounterVisible(false);
        }
    };

    const trackVerticalScrolling = useCallback((event) => {
        scrollingVerticalOffset.current = event.nativeEvent.contentOffset.y;
        handleUnreadFloatingButton();
        onScroll(event);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const scrollToBottomAndMarkReportAsRead = () => {
        reportScrollManager.scrollToBottom();
        readActionSkipped.current = false;
        Report.readNewestAction(report.reportID);
    };

    /**
     * Calculates the ideal number of report actions to render in the first render, based on the screen height and on
     * the height of the smallest report action possible.
     * @return {Number}
     */
    const initialNumToRender = useMemo(() => {
        const minimumReportActionHeight = styles.chatItem.paddingTop + styles.chatItem.paddingBottom + variables.fontSizeNormalHeight;
        const availableHeight = windowHeight - (CONST.CHAT_FOOTER_MIN_HEIGHT + variables.contentHeaderHeight);
        const itemsToRender = Math.ceil(availableHeight / minimumReportActionHeight);
        return itemsToRender > 0 ? itemsToRender : undefined;
    }, [styles.chatItem.paddingBottom, styles.chatItem.paddingTop, windowHeight]);

    /**
     * Thread's divider line should hide when the first chat in the thread is marked as unread.
     * This is so that it will not be conflicting with header's separator line.
     */
    const shouldHideThreadDividerLine = useMemo(
        () => ReportActionsUtils.getFirstVisibleReportActionID(sortedReportActions, isOffline) === currentUnreadMarker,
        [sortedReportActions, isOffline, currentUnreadMarker],
    );

    /**
     * Evaluate new unread marker visibility for each of the report actions.
     * @returns boolean
     */

    const shouldDisplayNewMarker = useCallback(
        (reportAction, index) => {
            let shouldDisplay = false;
            if (!currentUnreadMarker) {
                const nextMessage = sortedVisibleReportActions[index + 1];
                const isCurrentMessageUnread = isMessageUnread(reportAction, lastReadTimeRef.current);
                shouldDisplay = isCurrentMessageUnread && (!nextMessage || !isMessageUnread(nextMessage, lastReadTimeRef.current)) && !ReportActionsUtils.shouldHideNewMarker(reportAction);
                if (shouldDisplay && !messageManuallyMarkedUnread) {
                    const isWithinVisibleThreshold = scrollingVerticalOffset.current < MSG_VISIBLE_THRESHOLD ? reportAction.created < userActiveSince.current : true;
                    // Prevent displaying a new marker line when report action is of type "REPORTPREVIEW" and last actor is the current user
                    shouldDisplay =
                        (ReportActionsUtils.isReportPreviewAction(reportAction) ? !reportAction.childLastActorAccountID : reportAction.actorAccountID) !== Report.getCurrentUserAccountID() &&
                        isWithinVisibleThreshold;
                }
                if (shouldDisplay) {
                    cacheUnreadMarkers.set(report.reportID, reportAction.reportActionID);
                }
            } else {
                shouldDisplay = reportAction.reportActionID === currentUnreadMarker;
            }

            return shouldDisplay;
        },
        [currentUnreadMarker, sortedVisibleReportActions, report.reportID, messageManuallyMarkedUnread],
    );

    const calculateUnreadMarker = useCallback(() => {
        // Iterate through the report actions and set appropriate unread marker.
        // This is to avoid a warning of:
        // Cannot update a component (ReportActionsList) while rendering a different component (CellRenderer).
        let markerFound = false;
        _.each(sortedVisibleReportActions, (reportAction, index) => {
            if (!shouldDisplayNewMarker(reportAction, index)) {
                return;
            }
            markerFound = true;
            if (!currentUnreadMarker && currentUnreadMarker !== reportAction.reportActionID) {
                cacheUnreadMarkers.set(report.reportID, reportAction.reportActionID);
                setCurrentUnreadMarker(reportAction.reportActionID);
            }
        });
        if (!markerFound) {
            setCurrentUnreadMarker(null);
        }
    }, [sortedVisibleReportActions, report.reportID, shouldDisplayNewMarker, currentUnreadMarker]);

    useEffect(() => {
        calculateUnreadMarker();
    }, [calculateUnreadMarker, report.lastReadTime, messageManuallyMarkedUnread]);

    useEffect(() => {
        if (!userActiveSince.current || report.reportID !== prevReportID) {
            return;
        }

        if (!isVisible || !isFocused) {
            if (!lastMessageTime.current) {
                lastMessageTime.current = lodashGet(sortedVisibleReportActions, '[0].created', '');
            }
            return;
        }

        // In case the user read new messages (after being inactive) with other device we should
        // show marker based on report.lastReadTime
        const newMessageTimeReference = lastMessageTime.current > report.lastReadTime ? userActiveSince.current : report.lastReadTime;
        lastMessageTime.current = null;
        if (
            scrollingVerticalOffset.current >= MSG_VISIBLE_THRESHOLD ||
            !(
                sortedVisibleReportActions &&
                _.some(
                    sortedVisibleReportActions,
                    (reportAction) =>
                        newMessageTimeReference < reportAction.created &&
                        (ReportActionsUtils.isReportPreviewAction(reportAction) ? reportAction.childLastActorAccountID : reportAction.actorAccountID) !== Report.getCurrentUserAccountID(),
                )
            )
        ) {
            return;
        }

        Report.readNewestAction(report.reportID);
        userActiveSince.current = DateUtils.getDBTime();
        lastReadTimeRef.current = newMessageTimeReference;
        setCurrentUnreadMarker(null);
        cacheUnreadMarkers.delete(report.reportID);
        calculateUnreadMarker();

        // This effect logic to `mark as read` will only run when the report focused has new messages and the App visibility
        //  is changed to visible(meaning user switched to app/web, while user was previously using different tab or application).
        // We will mark the report as read in the above case which marks the LHN report item as read while showing the new message
        // marker for the chat messages received while the user wasn't focused on the report or on another browser tab for web.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isFocused, isVisible]);

    const renderItem = useCallback(
        ({item: reportAction, index}) => (
            <ReportActionsListItemRenderer
                reportAction={reportAction}
                parentReportAction={parentReportAction}
                index={index}
                report={report}
                linkedReportActionID={linkedReportActionID}
                displayAsGroup={ReportActionsUtils.isConsecutiveActionMadeByPreviousActor(sortedReportActions, index)}
                mostRecentIOUReportActionID={mostRecentIOUReportActionID}
                shouldHideThreadDividerLine={shouldHideThreadDividerLine}
                shouldDisplayNewMarker={shouldDisplayNewMarker(reportAction, index)}
            />
        ),
        [report, linkedReportActionID, sortedReportActions, mostRecentIOUReportActionID, shouldHideThreadDividerLine, shouldDisplayNewMarker, parentReportAction],
    );

    // Native mobile does not render updates flatlist the changes even though component did update called.
    // To notify there something changes we can use extraData prop to flatlist
    const extraData = useMemo(() => [isSmallScreenWidth ? currentUnreadMarker : undefined, ReportUtils.isArchivedRoom(report)], [currentUnreadMarker, isSmallScreenWidth, report]);
    const hideComposer = !ReportUtils.canUserPerformWriteAction(report);
    const shouldShowReportRecipientLocalTime = ReportUtils.canShowReportRecipientLocalTime(personalDetailsList, report, currentUserPersonalDetails.accountID) && !isComposerFullSize;

    const contentContainerStyle = useMemo(
        () => [styles.chatContentScrollView, isLoadingNewerReportActions ? styles.chatContentScrollViewWithHeaderLoader : {}],
        [isLoadingNewerReportActions, styles.chatContentScrollView, styles.chatContentScrollViewWithHeaderLoader],
    );

    const lastReportAction = useMemo(() => _.last(sortedReportActions) || {}, [sortedReportActions]);

    const listFooterComponent = useCallback(() => {
        // Skip this hook on the first render (when online), as we are not sure if more actions are going to be loaded,
        // Therefore showing the skeleton on footer might be misleading.
        // When offline, there should be no second render, so we should show the skeleton if the corresponding loading prop is present
        if (!isOffline && !hasFooterRendered.current) {
            hasFooterRendered.current = true;
            return null;
        }

        return (
            <ListBoundaryLoader
                type={CONST.LIST_COMPONENTS.FOOTER}
                isLoadingOlderReportActions={isLoadingOlderReportActions}
                isLoadingInitialReportActions={isLoadingInitialReportActions}
                lastReportActionName={lastReportAction.actionName}
            />
        );
    }, [isLoadingInitialReportActions, isLoadingOlderReportActions, lastReportAction.actionName, isOffline]);

    const onLayoutInner = useCallback(
        (event) => {
            onLayout(event);
        },
        [onLayout],
    );

    const listHeaderComponent = useCallback(() => {
        if (!isOffline && !hasHeaderRendered.current) {
            hasHeaderRendered.current = true;
            return null;
        }

        return (
            <ListBoundaryLoader
                type={CONST.LIST_COMPONENTS.HEADER}
                isLoadingNewerReportActions={isLoadingNewerReportActions}
            />
        );
    }, [isLoadingNewerReportActions, isOffline]);

    return (
        <>
            <FloatingMessageCounter
                isActive={isFloatingMessageCounterVisible && !!currentUnreadMarker}
                onClick={scrollToBottomAndMarkReportAsRead}
            />
            <Animated.View style={[animatedStyles, styles.flex1, !shouldShowReportRecipientLocalTime && !hideComposer ? styles.pb4 : {}]}>
                <InvertedFlatList
                    accessibilityLabel={translate('sidebarScreen.listOfChatMessages')}
                    ref={reportScrollManager.ref}
                    testID="report-actions-list"
                    style={styles.overscrollBehaviorContain}
                    data={sortedReportActions}
                    renderItem={renderItem}
                    contentContainerStyle={contentContainerStyle}
                    keyExtractor={keyExtractor}
                    initialNumToRender={initialNumToRender}
                    onEndReached={loadOlderChats}
                    onEndReachedThreshold={0.75}
                    onStartReached={loadNewerChats}
                    onStartReachedThreshold={0.75}
                    ListFooterComponent={listFooterComponent}
                    ListHeaderComponent={listHeaderComponent}
                    keyboardShouldPersistTaps="handled"
                    onLayout={onLayoutInner}
                    onScroll={trackVerticalScrolling}
                    onScrollToIndexFailed={onScrollToIndexFailed}
                    extraData={extraData}
                />
            </Animated.View>
        </>
    );
}

ReportActionsList.propTypes = propTypes;
ReportActionsList.defaultProps = defaultProps;
ReportActionsList.displayName = 'ReportActionsList';

export default compose(withWindowDimensions, withCurrentUserPersonalDetails)(memo(ReportActionsList));
