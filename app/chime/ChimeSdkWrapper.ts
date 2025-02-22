import {
  AsyncScheduler,
  AudioVideoFacade,
  ConsoleLogger,
  DefaultDeviceController,
  DataMessage,
  DefaultMeetingSession,
  DefaultModality,
  DeviceChangeObserver,
  LogLevel,
  MeetingSession,
  MeetingSessionConfiguration,
  ReconnectingPromisedWebSocket,
  DefaultActiveSpeakerPolicy
} from 'amazon-chime-sdk-js';

import { useIntl } from 'react-intl';
import throttle from 'lodash/throttle';

import DeviceType from '../types/DeviceType';
import FullDeviceInfoType from '../types/FullDeviceInfoType';
import MessageUpdateCallbackType from '../types/MessageUpdateCallbackType';
import RegionType from '../types/RegionType';
import RosterType from '../types/RosterType';
import getBaseUrl from '../utils/getBaseUrl';
import OptionalFeature from '../enums/OptionalFeature';

export default class ChimeSdkWrapper implements DeviceChangeObserver {
  intl = useIntl();

  private static DATA_MESSAGE_LIFETIME_MS = 10000;

  private static ROSTER_THROTTLE_MS = 400;

  meetingSession: MeetingSession | null = null;

  audioVideo: AudioVideoFacade | null = null;

  title: string | null = null;

  name: string | null = null;

  region: string | null = null;

  supportedChimeRegions: RegionType[] = [
    { label: 'United States (N. Virginia)', value: 'us-east-1' }
  ];

  currentAudioInputDevice: DeviceType | null = null;

  currentAudioOutputDevice: DeviceType | null = null;

  currentVideoInputDevice: DeviceType | null = null;

  audioInputDevices: DeviceType[] = [];

  audioOutputDevices: DeviceType[] = [];

  videoInputDevices: DeviceType[] = [];

  devicesUpdatedCallbacks: ((
    fullDeviceInfo: FullDeviceInfoType
  ) => void)[] = [];

  roster: RosterType = {};

  rosterUpdateCallbacks: ((roster: RosterType) => void)[] = [];

  configuration: MeetingSessionConfiguration | null = null;

  messagingSocket: ReconnectingPromisedWebSocket | null = null;

  messageUpdateCallbacks: MessageUpdateCallbackType[] = [];

  initializeSdkWrapper = async () => {
    this.meetingSession = null;
    this.audioVideo = null;
    this.title = null;
    this.name = null;
    this.region = null;
    this.currentAudioInputDevice = null;
    this.currentAudioOutputDevice = null;
    this.currentVideoInputDevice = null;
    this.audioInputDevices = [];
    this.audioOutputDevices = [];
    this.videoInputDevices = [];
    this.roster = {};
    this.rosterUpdateCallbacks = [];
    this.configuration = null;
    this.messagingSocket = null;
    this.messageUpdateCallbacks = [];
  };

  // Code block for regions
  lookupClosestChimeRegion = async (): Promise<RegionType> => {
    let region: string;
    try {
      const response = await fetch(`https://nearest-media-region.l.chime.aws`, {
        method: 'GET'
      });
      const json = await response.json();
      if (json.error) {
        throw new Error(
          `${this.intl.formatMessage({
            id: 'CreateOrJoin.serverError'
          })}: ${json.error}`
        );
      }
      region = json.region;
    } catch (error) {
      this.logError(error);
    }
    return (
      this.supportedChimeRegions.find(({ value }) => value === region) ||
      this.supportedChimeRegions[0]
    );
  };

  createRoom = async (
    title: string | null,
    name: string | null,
    region: string | null,
    role: string | null,
    optionalFeature: string | null
  ): Promise<void> => {
    if (!title || !name || !region || !role) {
      this.logError(
        new Error(
          `title=${title} name=${name} region=${region} role=${role} must exist`
        )
      );
      return;
    }

    const response = await fetch(
      `${getBaseUrl()}join?title=${encodeURIComponent(
        title
      )}&name=${encodeURIComponent(name)}&region=${encodeURIComponent(
        region
      )}&role=${encodeURIComponent(role)}`,
      {
        method: 'POST'
      }
    );
    const json = await response.json();
    if (json.error) {
      throw new Error(
        `${this.intl.formatMessage({
          id: 'CreateOrJoin.serverError'
        })}: ${json.error}`
      );
    }

    const { JoinInfo } = json;
    if (!JoinInfo) {
      throw new Error(
        this.intl.formatMessage({
          id: 'CreateOrJoin.classRoomDoesNotExist'
        })
      );
    }
    this.configuration = new MeetingSessionConfiguration(
      JoinInfo.Meeting,
      JoinInfo.Attendee
    );
    if (optionalFeature === OptionalFeature.Simulcast) {
      this.configuration.enableUnifiedPlanForChromiumBasedBrowsers = true;
      this.configuration.enableSimulcastForUnifiedPlanChromiumBasedBrowsers = true;
    }
    await this.initializeMeetingSession(this.configuration);

    this.title = title;
    this.name = name;
    this.region = region;
  };

  initializeMeetingSession = async (
    configuration: MeetingSessionConfiguration
  ): Promise<void> => {
    const logger = new ConsoleLogger('SDK', LogLevel.DEBUG);
    const deviceController = new DefaultDeviceController(logger);
    this.meetingSession = new DefaultMeetingSession(
      configuration,
      logger,
      deviceController
    );
    this.audioVideo = this.meetingSession.audioVideo;

    this.audioInputDevices = [];
    (await this.audioVideo?.listAudioInputDevices()).forEach(
      (mediaDeviceInfo: MediaDeviceInfo) => {
        this.audioInputDevices.push({
          label: mediaDeviceInfo.label,
          value: mediaDeviceInfo.deviceId
        });
      }
    );
    this.audioOutputDevices = [];
    (await this.audioVideo?.listAudioOutputDevices()).forEach(
      (mediaDeviceInfo: MediaDeviceInfo) => {
        this.audioOutputDevices.push({
          label: mediaDeviceInfo.label,
          value: mediaDeviceInfo.deviceId
        });
      }
    );
    this.videoInputDevices = [];
    (await this.audioVideo?.listVideoInputDevices()).forEach(
      (mediaDeviceInfo: MediaDeviceInfo) => {
        this.videoInputDevices.push({
          label: mediaDeviceInfo.label,
          value: mediaDeviceInfo.deviceId
        });
      }
    );
    this.publishDevicesUpdated();
    this.audioVideo?.addDeviceChangeObserver(this);

    this.audioVideo?.realtimeSubscribeToAttendeeIdPresence(
      (presentAttendeeId: string, present: boolean): void => {
        if (!present) {
          delete this.roster[presentAttendeeId];
          this.publishRosterUpdate.cancel();
          this.publishRosterUpdate();
          return;
        }

        this.audioVideo?.realtimeSubscribeToVolumeIndicator(
          presentAttendeeId,
          async (
            attendeeId: string,
            volume: number | null,
            muted: boolean | null,
            signalStrength: number | null
          ) => {
            const baseAttendeeId = new DefaultModality(attendeeId).base();
            if (baseAttendeeId !== attendeeId) {
              return;
            }

            let shouldPublishImmediately = false;

            if (!this.roster[attendeeId]) {
              this.roster[attendeeId] = { name: '' };
            }
            if (volume !== null) {
              this.roster[attendeeId].volume = Math.round(volume * 100);
            }
            if (muted !== null) {
              this.roster[attendeeId].muted = muted;
            }
            if (signalStrength !== null) {
              this.roster[attendeeId].signalStrength = Math.round(
                signalStrength * 100
              );
            }
            if (this.title && attendeeId && !this.roster[attendeeId].name) {
              const response = await fetch(
                `${getBaseUrl()}attendee?title=${encodeURIComponent(
                  this.title
                )}&attendee=${encodeURIComponent(attendeeId)}`
              );
              const json = await response.json();
              this.roster[attendeeId].name = json.AttendeeInfo.Name || '';
              shouldPublishImmediately = true;
            }

            if (shouldPublishImmediately) {
              this.publishRosterUpdate.cancel();
            }
            this.publishRosterUpdate();
          }
        );
      }
    );

    this.audioVideo.subscribeToActiveSpeakerDetector(
      new DefaultActiveSpeakerPolicy(),
      (attendeeIds: string[]): void => {
        Object.keys(this.roster).forEach(attendeeId => {
          this.roster[attendeeId].active = false;
        });

        attendeeIds.some(attendeeId => {
          if (this.roster[attendeeId]) {
            this.roster[attendeeId].active = true;
            return true; // only show the most active speaker
          }
          return false;
        });
      }
    );
  };

  joinRoom = async (element: HTMLAudioElement | null): Promise<void> => {
    if (!element) {
      this.logError(new Error(`element does not exist`));
      return;
    }

    window.addEventListener(
      'unhandledrejection',
      (event: PromiseRejectionEvent) => {
        this.logError(event.reason);
      }
    );

    const audioInputs = await this.audioVideo?.listAudioInputDevices();
    if (audioInputs && audioInputs.length > 0 && audioInputs[0].deviceId) {
      this.currentAudioInputDevice = {
        label: audioInputs[0].label,
        value: audioInputs[0].deviceId
      };
      await this.audioVideo?.chooseAudioInputDevice(audioInputs[0].deviceId);
    }

    const audioOutputs = await this.audioVideo?.listAudioOutputDevices();
    if (audioOutputs && audioOutputs.length > 0 && audioOutputs[0].deviceId) {
      this.currentAudioOutputDevice = {
        label: audioOutputs[0].label,
        value: audioOutputs[0].deviceId
      };
      await this.audioVideo?.chooseAudioOutputDevice(audioOutputs[0].deviceId);
    }

    const videoInputs = await this.audioVideo?.listVideoInputDevices();
    if (videoInputs && videoInputs.length > 0 && videoInputs[0].deviceId) {
      this.currentVideoInputDevice = {
        label: videoInputs[0].label,
        value: videoInputs[0].deviceId
      };
      await this.audioVideo?.chooseVideoInputDevice(null);
    }

    this.publishDevicesUpdated();

    this.audioVideo?.bindAudioElement(element);
    this.audioVideo?.start();
  };

  sendMessage = (topic: string, data: any) => {
    new AsyncScheduler().start(() => {
      this.audioVideo?.realtimeSendDataMessage(
        topic,
        data,
        ChimeSdkWrapper.DATA_MESSAGE_LIFETIME_MS
      );
      this.publishMessageUpdate(
        new DataMessage(
          Date.now(),
          topic,
          new TextEncoder().encode(data),
          this.meetingSession?.configuration.credentials?.attendeeId || '',
          this.meetingSession?.configuration.credentials?.externalUserId || ''
        )
      );
    });
  };

  leaveRoom = async (end: boolean): Promise<void> => {
    try {
      this.audioVideo?.stop();
    } catch (error) {
      this.logError(error);
    }

    try {
      if (end && this.title) {
        await fetch(
          `${getBaseUrl()}end?title=${encodeURIComponent(this.title)}`,
          {
            method: 'POST'
          }
        );
      }
    } catch (error) {
      this.logError(error);
    }

    this.initializeSdkWrapper();
  };

  //device

  chooseAudioInputDevice = async (device: DeviceType) => {
    try {
      await this.audioVideo?.chooseAudioInputDevice(device.value);
      this.currentAudioInputDevice = device;
    } catch (error) {
      this.logError(error);
    }
  };

  chooseAudioOutputDevice = async (device: DeviceType) => {
    try {
      await this.audioVideo?.chooseAudioOutputDevice(device.value);
      this.currentAudioOutputDevice = device;
    } catch (error) {
      this.logError(error);
    }
  };

  chooseVideoInputDevice = async (device: DeviceType) => {
    try {
      await this.audioVideo?.chooseVideoInputDevice(device.value);
      this.currentVideoInputDevice = device;
    } catch (error) {
      this.logError(error);
    }
  };

  // observer methods

  audioInputsChanged(freshAudioInputDeviceList: MediaDeviceInfo[]): void {
    let hasCurrentDevice = false;
    this.audioInputDevices = [];
    freshAudioInputDeviceList.forEach((mediaDeviceInfo: MediaDeviceInfo) => {
      if (
        this.currentAudioInputDevice &&
        mediaDeviceInfo.deviceId === this.currentAudioInputDevice.value
      ) {
        hasCurrentDevice = true;
      }
      this.audioInputDevices.push({
        label: mediaDeviceInfo.label,
        value: mediaDeviceInfo.deviceId
      });
    });
    if (!hasCurrentDevice) {
      this.currentAudioInputDevice =
        this.audioInputDevices.length > 0 ? this.audioInputDevices[0] : null;
    }
    this.publishDevicesUpdated();
  }

  audioOutputsChanged(freshAudioOutputDeviceList: MediaDeviceInfo[]): void {
    let hasCurrentDevice = false;
    this.audioOutputDevices = [];
    freshAudioOutputDeviceList.forEach((mediaDeviceInfo: MediaDeviceInfo) => {
      if (
        this.currentAudioOutputDevice &&
        mediaDeviceInfo.deviceId === this.currentAudioOutputDevice.value
      ) {
        hasCurrentDevice = true;
      }
      this.audioOutputDevices.push({
        label: mediaDeviceInfo.label,
        value: mediaDeviceInfo.deviceId
      });
    });
    if (!hasCurrentDevice) {
      this.currentAudioOutputDevice =
        this.audioOutputDevices.length > 0 ? this.audioOutputDevices[0] : null;
    }
    this.publishDevicesUpdated();
  }

  videoInputsChanged(freshVideoInputDeviceList: MediaDeviceInfo[]): void {
    let hasCurrentDevice = false;
    this.videoInputDevices = [];
    freshVideoInputDeviceList.forEach((mediaDeviceInfo: MediaDeviceInfo) => {
      if (
        this.currentVideoInputDevice &&
        mediaDeviceInfo.deviceId === this.currentVideoInputDevice.value
      ) {
        hasCurrentDevice = true;
      }
      this.videoInputDevices.push({
        label: mediaDeviceInfo.label,
        value: mediaDeviceInfo.deviceId
      });
    });
    if (!hasCurrentDevice) {
      this.currentVideoInputDevice =
        this.videoInputDevices.length > 0 ? this.videoInputDevices[0] : null;
    }
    this.publishDevicesUpdated();
  }

  /**
   * ====================================================================
   * Subscribe and unsubscribe from SDK events
   * ====================================================================
   */

  subscribeToDevicesUpdated = (
    callback: (fullDeviceInfo: FullDeviceInfoType) => void
  ) => {
    this.devicesUpdatedCallbacks.push(callback);
  };

  unsubscribeFromDevicesUpdated = (
    callback: (fullDeviceInfo: FullDeviceInfoType) => void
  ) => {
    const index = this.devicesUpdatedCallbacks.indexOf(callback);
    if (index !== -1) {
      this.devicesUpdatedCallbacks.splice(index, 1);
    }
  };

  private publishDevicesUpdated = () => {
    this.devicesUpdatedCallbacks.forEach(
      (callback: (fullDeviceInfo: FullDeviceInfoType) => void) => {
        callback({
          currentAudioInputDevice: this.currentAudioInputDevice,
          currentAudioOutputDevice: this.currentAudioOutputDevice,
          currentVideoInputDevice: this.currentVideoInputDevice,
          audioInputDevices: this.audioInputDevices,
          audioOutputDevices: this.audioOutputDevices,
          videoInputDevices: this.videoInputDevices
        });
      }
    );
  };

  subscribeToRosterUpdate = (callback: (roster: RosterType) => void) => {
    this.rosterUpdateCallbacks.push(callback);
  };

  unsubscribeFromRosterUpdate = (callback: (roster: RosterType) => void) => {
    const index = this.rosterUpdateCallbacks.indexOf(callback);
    if (index !== -1) {
      this.rosterUpdateCallbacks.splice(index, 1);
    }
  };

  private publishRosterUpdate = throttle(() => {
    for (let i = 0; i < this.rosterUpdateCallbacks.length; i += 1) {
      const callback = this.rosterUpdateCallbacks[i];
      callback(this.roster);
    }
  }, ChimeSdkWrapper.ROSTER_THROTTLE_MS);

  subscribeToMessageUpdate = (
    messageUpdateCallback: MessageUpdateCallbackType
  ) => {
    this.messageUpdateCallbacks.push(messageUpdateCallback);
    this.audioVideo?.realtimeSubscribeToReceiveDataMessage(
      messageUpdateCallback.topic,
      messageUpdateCallback.callback
    );
  };

  unsubscribeFromMessageUpdate = (
    messageUpdateCallback: MessageUpdateCallbackType
  ) => {
    const index = this.messageUpdateCallbacks.indexOf(messageUpdateCallback);
    if (index !== -1) {
      this.messageUpdateCallbacks.splice(index, 1);
    }
    this.audioVideo?.realtimeUnsubscribeFromReceiveDataMessage(
      messageUpdateCallback.topic
    );
  };

  private publishMessageUpdate = (message: DataMessage) => {
    for (let i = 0; i < this.messageUpdateCallbacks.length; i += 1) {
      const messageUpdateCallback = this.messageUpdateCallbacks[i];
      if (messageUpdateCallback.topic === message.topic) {
        messageUpdateCallback.callback(message);
      }
    }
  };

  // utilities
  private logError = (error: Error) => {
    console.error(error);
  };
}
