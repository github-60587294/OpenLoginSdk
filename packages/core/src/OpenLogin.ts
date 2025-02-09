import { decrypt, Ecies, encrypt, getPublic, sign } from "@toruslabs/eccrypto";
import { post } from "@toruslabs/http-helpers";
import { getRpcPromiseCallback, JRPCRequest, LoginConfig, OriginData, SessionInfo, WhiteLabelData } from "@toruslabs/openlogin-jrpc";
import { base64url, jsonToBase64, keccak, randomId } from "@toruslabs/openlogin-utils";
import merge from "lodash.merge";

import {
  ALLOWED_INTERACTIONS,
  BaseLogoutParams,
  BaseRedirectParams,
  CUSTOM_LOGIN_PROVIDER_TYPE,
  LOGIN_PROVIDER_TYPE,
  LoginParams,
  OPENLOGIN_METHOD,
  OPENLOGIN_NETWORK,
  OPENLOGIN_NETWORK_TYPE,
  OpenLoginOptions,
  OpenloginUserInfo,
  RequestParams,
  UX_MODE,
  UX_MODE_TYPE,
} from "./constants";
import { Modal } from "./Modal";
import OpenLoginStore from "./OpenLoginStore";
import Provider from "./Provider";
import { awaitReq, constructURL, getHashQueryParams, getPopupFeatures, preloadIframe } from "./utils";

preloadIframe("https://app.openlogin.com/start");
preloadIframe("https://app.openlogin.com/sdk-modal");

export type OpenLoginState = {
  network: OPENLOGIN_NETWORK_TYPE;
  privKey?: string;
  walletKey?: string;
  tKey?: string;
  oAuthPrivateKey?: string;
  support3PC?: boolean;
  clientId: string;
  iframeUrl: string;
  redirectUrl: string;
  startUrl: string;
  popupUrl: string;
  store: OpenLoginStore;
  uxMode: UX_MODE_TYPE;
  replaceUrlOnRedirect: boolean;
  originData: OriginData;
  whiteLabel: WhiteLabelData;
  loginConfig: LoginConfig;
};

class OpenLogin {
  provider: Provider;

  state: OpenLoginState;

  modal: Modal;

  constructor(options: OpenLoginOptions) {
    this.provider = new Proxy(new Provider(), {
      deleteProperty: () => true, // work around for web3
    });
    if (!options._iframeUrl) {
      if (options.network === OPENLOGIN_NETWORK.MAINNET) {
        options._iframeUrl = "https://app.openlogin.com";
      } else if (options.network === OPENLOGIN_NETWORK.TESTNET) {
        options._iframeUrl = "https://beta.openlogin.com";
      }
    }
    if (!options._iframeUrl) {
      throw new Error("unspecified network and iframeUrl");
    }
    this.modal = new Modal(`${options._iframeUrl}/sdk-modal`);
    this.initState({
      ...options,
      no3PC: options.no3PC ?? false,
      _iframeUrl: options._iframeUrl,
      _startUrl: options._startUrl ?? `${options._iframeUrl}/start`,
      _popupUrl: options._popupUrl ?? `${options._iframeUrl}/popup-window`,
      redirectUrl: options.redirectUrl ?? `${window.location.protocol}//${window.location.host}${window.location.pathname}`,
      uxMode: options.uxMode ?? UX_MODE.REDIRECT,
      replaceUrlOnRedirect: options.replaceUrlOnRedirect ?? true,
      originData: options.originData ?? { [window.location.origin]: "" },
      whiteLabel: options.whiteLabel ?? {},
      loginConfig: options.loginConfig ?? {},
    });
  }

  initState(options: Required<OpenLoginOptions>): void {
    this.state = {
      uxMode: options.uxMode,
      network: options.network,
      store: OpenLoginStore.getInstance(),
      iframeUrl: options._iframeUrl,
      startUrl: options._startUrl,
      popupUrl: options._popupUrl,
      clientId: options.clientId,
      redirectUrl: options.redirectUrl,
      replaceUrlOnRedirect: options.replaceUrlOnRedirect,
      originData: options.originData,
      loginConfig: options.loginConfig,
      support3PC: !options.no3PC,
      whiteLabel: options.whiteLabel,
    };
  }

  async init(): Promise<void> {
    if (this.state.support3PC) {
      await Promise.all([this.provider.init({ iframeUrl: this.state.iframeUrl }), this.modal.init(), this.updateOriginData()]);
      this._syncState(getHashQueryParams(this.state.replaceUrlOnRedirect));
      const res = await this._check3PCSupport();
      this.state.support3PC = !!res.support3PC;
      if (this.state.support3PC) {
        this._syncState(await this._getData());
      }
    } else {
      await this.updateOriginData();
      this._syncState(getHashQueryParams(this.state.replaceUrlOnRedirect));
    }
  }

  get privKey(): string {
    return this.state.privKey ? this.state.privKey.padStart(64, "0") : "";
  }

  async updateOriginData(): Promise<void> {
    const filteredOriginData = JSON.parse(JSON.stringify(this.state.originData));
    Object.keys(filteredOriginData).forEach((key) => {
      if (filteredOriginData[key] === "") delete filteredOriginData[key];
    });
    const [whitelist, whiteLabel] = await Promise.all([this.getWhitelist(), this.getWhiteLabel()]);
    this._syncState({ originData: { ...whitelist, ...filteredOriginData }, whiteLabel: { ...whiteLabel, ...this.state.whiteLabel } });
  }

  async getWhitelist(): Promise<OriginData> {
    try {
      const { clientId } = this.state;
      if (!clientId) {
        throw new Error("unspecified clientId");
      }
      const res = await post<{ signed_urls: OriginData }>("https://api.developer.tor.us/whitelist", {
        project_id: this.state.clientId,
      });
      return res.signed_urls;
    } catch (_) {
      // fail silently
      return {};
    }
  }

  async getWhiteLabel(): Promise<WhiteLabelData> {
    try {
      const { clientId } = this.state;
      if (!clientId) {
        throw new Error("unspecified clientId");
      }
      const res = await post<{ whiteLabel: WhiteLabelData }>("https://api.developer.tor.us/whitelabel", {
        project_id: this.state.clientId,
      });
      return res.whiteLabel;
    } catch (_) {
      // fail silently
      return {};
    }
  }

  async _fastLogin(params: Partial<BaseRedirectParams>): Promise<{ privKey: string }> {
    const defaultParams: BaseRedirectParams = {
      redirectUrl: this.state.redirectUrl,
    };

    const loginParams: BaseRedirectParams = {
      ...defaultParams,
      ...params,
    };

    const res = await this.request<{ privKey: string }>({
      params: [{ ...loginParams, fastLogin: true }],
      method: OPENLOGIN_METHOD.LOGIN,
      startUrl: this.state.startUrl,
      popupUrl: this.state.popupUrl,
      allowedInteractions: [ALLOWED_INTERACTIONS.POPUP, ALLOWED_INTERACTIONS.REDIRECT],
    });

    this.state.privKey = res.privKey;
    return res;
  }

  async login(params?: LoginParams & Partial<BaseRedirectParams>): Promise<{ privKey: string }> {
    if (params?.loginProvider) {
      return this._selectedLogin(params);
    }
    return this._modal(params);
  }

  async _selectedLogin(params: LoginParams & Partial<BaseRedirectParams>): Promise<{ privKey: string }> {
    const defaultParams: BaseRedirectParams = {
      redirectUrl: this.state.redirectUrl,
    };

    const loginParams: LoginParams = {
      loginProvider: params.loginProvider,
      ...defaultParams,
      ...params,
    };

    // fast login flow
    // if (this.state.store.get("touchIDPreference") === "enabled" && !loginParams.extraLoginOptions?.login_hint) {
    //   return this._fastLogin(loginParams);
    // }

    const res = await this.request<{ privKey: string }>({
      method: OPENLOGIN_METHOD.LOGIN,
      allowedInteractions: [UX_MODE.REDIRECT, UX_MODE.POPUP],
      startUrl: this.state.startUrl,
      popupUrl: this.state.popupUrl,
      params: [loginParams],
    });
    this.state.privKey = res.privKey;
    return { privKey: this.privKey };
  }

  async logout(logoutParams: Partial<BaseLogoutParams> & Partial<BaseRedirectParams> = {}): Promise<void> {
    const params: Record<string, unknown> = {};
    // defaults
    params.redirectUrl = this.state.redirectUrl;
    params._clientId = this.state.clientId;

    if (logoutParams.clientId) {
      params._clientId = logoutParams.clientId;
    }
    if (logoutParams.fastLogin !== undefined) {
      params.fastLogin = logoutParams.fastLogin;
    }
    if (logoutParams.redirectUrl !== undefined) {
      params.redirectUrl = logoutParams.redirectUrl;
    }

    const res = await this.request<void>({
      method: OPENLOGIN_METHOD.LOGOUT,
      params: [params],
      startUrl: this.state.startUrl,
      popupUrl: this.state.popupUrl,
      allowedInteractions: [ALLOWED_INTERACTIONS.JRPC, ALLOWED_INTERACTIONS.POPUP, ALLOWED_INTERACTIONS.REDIRECT],
    });

    this.state.privKey = "";
    // if (!params.fastLogin) this.state.store.set("touchIDPreference", "disabled");
    return res;
  }

  async request<T>(args: RequestParams): Promise<T> {
    const pid = randomId();
    let { params } = args;

    // Note: _origin is added later in postMessageStream for jrpc requests
    // do not add it here since its used for checking postMessage constraints
    const session: Partial<SessionInfo> = {};
    if (params.length !== 1) throw new Error("request params array should have only one element");
    const { startUrl, popupUrl, method, allowedInteractions } = args;
    if (allowedInteractions.length === 0) throw new Error("no allowed interactions");

    if (this.state.clientId) {
      session._clientId = this.state.clientId;
    }

    if (this.privKey) {
      const userData = {
        clientId: session._clientId,
        timestamp: Date.now().toString(),
      };
      const sig = await sign(
        Buffer.from(this.privKey, "hex"),
        Buffer.from(keccak("keccak256").update(JSON.stringify(userData)).digest("hex"), "hex")
      );
      session._user = getPublic(Buffer.from(this.privKey, "hex")).toString("hex");
      session._userSig = base64url.encode(sig);
      session._userData = userData;
    }

    session._originData = this.state.originData;
    session._whiteLabelData = this.state.whiteLabel;
    session._loginConfig = this.state.loginConfig;

    // add in session data (allow overrides)
    params = [{ ...session, ...params[0] }];

    // use JRPC where possible

    if (this.state.support3PC && allowedInteractions.includes(ALLOWED_INTERACTIONS.JRPC)) {
      return this._jrpcRequest<Record<string, unknown>[], T>({ method, params });
    }

    // set origin
    params[0]._origin = new URL((params[0].redirectUrl as string) ?? this.state.redirectUrl).origin;

    // preset params
    if (this.state.support3PC) {
      // set params first if 3PC supported
      await this._setPIDData(pid, params);
      // eslint-disable-next-line require-atomic-updates
      params = [{}];
    }

    if (!startUrl || !popupUrl) {
      throw new Error("no url for redirect / popup flow");
    }

    // method and pid are always in URL hash params
    // convert params from JSON to base64

    if (this.state.uxMode === UX_MODE.REDIRECT) {
      // if redirects preferred, check for redirect flows first, then check for popup flow

      if (allowedInteractions.includes(ALLOWED_INTERACTIONS.REDIRECT)) {
        // give time for synchronous methods to complete before redirect
        setTimeout(() => {
          window.location.href = constructURL({
            baseURL: startUrl,
            hash: { b64Params: jsonToBase64(params[0]), _pid: pid, _method: method },
          });
        }, 50);
        return {} as T;
      }

      if (allowedInteractions.includes(ALLOWED_INTERACTIONS.POPUP)) {
        const u = new URL(
          constructURL({
            baseURL: popupUrl,
            hash: { b64Params: jsonToBase64(params[0]), _pid: pid, _method: method },
          })
        );
        const windowRef = window.open(u.toString(), "_blank", getPopupFeatures());
        return awaitReq<T>(pid, windowRef);
      }
    } else {
      // if popups preferred, check for popup flows first, then check for redirect flow

      if (allowedInteractions.includes(ALLOWED_INTERACTIONS.POPUP)) {
        const u = new URL(
          constructURL({
            baseURL: popupUrl,
            hash: { b64Params: jsonToBase64(params[0]), _pid: pid, _method: method },
          })
        );
        const windowRef = window.open(u.toString(), "_blank", getPopupFeatures());
        return awaitReq<T>(pid, windowRef);
      }

      if (allowedInteractions.includes(ALLOWED_INTERACTIONS.REDIRECT)) {
        // give time for synchronous methods to complete before redirect
        setTimeout(() => {
          window.location.href = constructURL({
            baseURL: startUrl,
            hash: { b64Params: jsonToBase64(params[0]), _pid: pid, _method: method },
          });
        }, 50);
        return null;
      }
    }

    throw new Error("no matching allowed interactions");
  }

  async _jrpcRequest<T, U>(args: JRPCRequest<T>): Promise<U> {
    // await this.initialized;
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("invalid request args");
    }

    const { method, params } = args;

    if (typeof method !== "string" || method.length === 0) {
      throw new Error("invalid request method");
    }

    if (params === undefined || !Array.isArray(params)) {
      throw new Error("invalid request params");
    }

    if (params.length === 0) {
      params.push({});
    }

    return new Promise<U>((resolve, reject) => {
      this.provider._rpcRequest({ method, params }, getRpcPromiseCallback(resolve, reject));
    });
  }

  async _check3PCSupport(): Promise<Record<string, boolean>> {
    return this._jrpcRequest<Record<string, unknown>[], Record<string, boolean>>({
      method: OPENLOGIN_METHOD.CHECK_3PC_SUPPORT,
      params: [{ _originData: this.state.originData }],
    });
  }

  async _setPIDData(pid: string, data: Record<string, unknown>[]): Promise<void> {
    await this.request({
      allowedInteractions: [ALLOWED_INTERACTIONS.JRPC],
      method: OPENLOGIN_METHOD.SET_PID_DATA,
      params: [
        {
          pid,
          data: data[0],
        },
      ],
    });
  }

  async _getData(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>({
      allowedInteractions: [ALLOWED_INTERACTIONS.JRPC],
      method: OPENLOGIN_METHOD.GET_DATA,
      params: [{}],
    });
  }

  _syncState(newState: Record<string, unknown>): void {
    if (newState.store) {
      if (typeof newState.store !== "object") {
        throw new Error("expected store to be an object");
      }
      Object.keys(newState.store).forEach((key) => {
        this.state.store.set(key, newState.store[key]);
      });
    }
    const { store } = this.state;
    this.state = { ...this.state, ...newState, store };
  }

  async _modal(params?: LoginParams & Partial<BaseRedirectParams>): Promise<{
    privKey: string;
  }> {
    return new Promise<{ privKey: string }>((resolve, reject) => {
      this.modal._prompt(this.state.clientId, this.state.whiteLabel, this.state.loginConfig, async (chunk): Promise<void> => {
        if (chunk.cancel) {
          reject(new Error("user canceled login"));
        } else {
          try {
            const selectedLoginResponse = await this._selectedLogin(merge(params, chunk));
            resolve(selectedLoginResponse);
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  }

  async _cleanup(): Promise<void> {
    await this.provider.cleanup();
    await this.modal.cleanup();
  }

  async encrypt(message: Buffer, privateKey?: string): Promise<Ecies> {
    let privKey = privateKey;
    if (!privKey) {
      privKey = this.privKey;
    }
    // validations
    if (!/^[0-9a-fA-f]{64}$/.exec(privKey)) {
      if (privKey === "" || privKey === undefined) {
        throw new Error("private key cannot be empty");
      } else {
        throw new Error("invalid private key in encrypt");
      }
    }
    return encrypt(getPublic(Buffer.from(privKey, "hex")), message);
  }

  async decrypt(ciphertext: Ecies, privateKey?: string): Promise<Buffer> {
    let privKey = privateKey;
    if (!privKey) {
      privKey = this.privKey;
    }
    // validations
    if (!/^[0-9a-fA-f]{64}$/.exec(privKey)) {
      if (privKey === "" || privKey === undefined) {
        throw new Error("private key cannot be empty");
      } else {
        throw new Error("invalid private key in decrypt");
      }
    }
    return decrypt(Buffer.from(privKey, "hex"), ciphertext);
  }

  async getUserInfo(): Promise<OpenloginUserInfo> {
    if (this.privKey) {
      const storeData = this.state.store.getStore();
      const userInfo: OpenloginUserInfo = {
        email: (storeData.email as string) || "",
        name: (storeData.name as string) || "",
        profileImage: (storeData.profileImage as string) || "",
        aggregateVerifier: (storeData.aggregateVerifier as string) || "",
        verifier: (storeData.verifier as string) || "",
        verifierId: (storeData.verifierId as string) || "",
        typeOfLogin: (storeData.typeOfLogin as LOGIN_PROVIDER_TYPE | CUSTOM_LOGIN_PROVIDER_TYPE) || "",
      };

      return userInfo;
    }
    throw new Error("user should be logged in to fetch userInfo");
  }
}

export default OpenLogin;
