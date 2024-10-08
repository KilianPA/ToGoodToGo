const moment = require("moment");
const account = require("../../model/account");
const requestModel = require("../../model/request");
const fs = require("fs");
moment.locale("fr");
const telegram = require("../../lib/telegram");

const ToGoodToGoClient = require("./client");
const prompt = require("async-prompt");
const { delay } = require("../../utils/delay");
const Datadome = require("../../client/datadome");

class TooGoodToGo {
  client;
  state = {};

  constructor(state) {
    this.state = {
      session: {},
      credentials: {},
      items: [],
      packages: [],
      ...state,
    };
    this.client = new ToGoodToGoClient(this);
    this.datadome = new Datadome();
  }

  async login(force = false) {
    if (!this.client.client.defaults.headers.common.Cookie) {
      const cookie = await this.datadome.getCookie();
      this.client.forceCookie(cookie);
    }
    if (!this.state.session?.accessToken || force) {
      const pendingRequest = await requestModel.getPendingRequest(
        this.state.accountId,
        "email_code"
      );
      if (pendingRequest) {
        if (pendingRequest.value) {
          await this.authByPinCode(pendingRequest.value);
          await requestModel.deleteRequest(pendingRequest.id);
        } else {
          console.log(
            `[TooGoodToGo] No pin code found for ${this.state.credentials.email}`
          );
          return;
        }
      } else {
        this.client.deleteHeaders(["Authorization", "Cookie"]);
        const { polling_id } = await this.client.login(
          this.state.credentials.email
        );
        this.state.session.pollingId = polling_id;
        await this.authenticate();
        await this.saveState();
        return;
      }
    }
    this.client.setBearerToken(this.state.session.accessToken);
    if (!this.state.session.cookie) {
      this.client.forceCookie(this.state.session.cookie);
    }

    await this.saveState();
    await this.setUser();
    await this.getHomePage();
    console.log(`[TooGoodToGo] logged in with ${this.state.credentials.email}`);
    await delay(6000);
    return this.state.session.accessToken;
  }

  async getHomePage() {
    return this.client.getHomePage({
      debug_mode: false,
      is_gps: true,
      supported_buckets: [
        {
          display_types: [
            "CAROUSEL",
            "DONATION",
            "JOB_APPLICATION",
            "RATE_ORDER",
            "STORE_REFERRAL",
            "DYNAMIC_PRICE",
            "DELIVERY_TAB",
            "CITY_GUIDE",
          ],
          type: "ACTION",
        },
        {
          type: "HEADER",
          display_types: [
            "SOLD_OUT",
            "ALMOST_SOLD_OUT",
            "NOTHING_NEARBY",
            "NOT_LIVE_HERE",
          ],
        },
        {
          type: "ITEM",
          display_types: [
            "CATEGORY",
            "CLASSIC",
            "FAVORITES",
            "RECOMMENDATIONS",
            "CHARITY",
            "VERTICAL",
            "MANUFACTURER",
            "FLASH_SALES",
            "FAVORITES_FLASH_SALES",
          ],
        },
        { type: "STORE", display_types: ["LOGO_ONLY"] },
      ],
      origin: { longitude: 7.188387094360283, latitude: 43.66380495317505 },
      experimental_group: "Default",
      origin_updated: true,
      radius: 10,
    });
  }

  async setUser() {
    const { user } = await this.client.getSettings();
    this.state.user = user;
    await this.saveState();
  }

  async authByPinCode(pinCode) {
    const { access_token, access_token_ttl_seconds, refresh_token } =
      await this.client.authByPinCode(
        this.state.credentials.email,
        pinCode,
        this.state.session.pollingId
      );
    this.state.session = {
      ...this.state.session,
      accessToken: access_token,
      accessTokenTtlSeconds: access_token_ttl_seconds,
      refreshToken: refresh_token,
      lastRefresh: moment(),
    };
    telegram.sendMessage(
      this.state.telegramConversationIds,
      "You are now logged in"
    );
  }

  async authenticate() {
    await this.client.authenticate(
      this.state.credentials.email,
      this.state.session.pollingId
    );
    telegram.sendMessage(
      this.state.telegramConversationIds,
      "Please check your email and enter the pin code :"
    );
    console.log("[TooGoodToGo] Waiting for pin code...");
    await requestModel.createRequest(this.state.accountId, "email_code");
  }
  async checkItemsWorkflow() {
    console.log(`[TooGoodToGo] checking items for ${this.state.user.email}`);
    return new Promise(async (resolve, reject) => {
      let items = await this.client.getItems({
        bucket: {
          filler_type: "Favorites",
        },
        origin: {
          latitude: 43.66370861766941,
          longitude: 7.186696684895937,
        },
        paging: {
          page: 0,
          size: 50,
        },
        radius: 1,
      });

      // Remove items already seen
      const itemsNotSeen = items.filter(
        (item) =>
          item.items_available > 0 &&
          !this.state.items.includes(item.item.item_id)
      );

      if (itemsNotSeen.length) {
        console.log(
          `[TooGoodToGo] found ${itemsNotSeen.length} new items available for ${this.state.user.email}`
        );
      } else {
        console.log(
          `[TooGoodToGo] no new items available for ${this.state.user.email}`
        );
      }

      // Add new items to itemsSeen
      this.state.items = [
        ...itemsNotSeen.map((item) => item.item.item_id),
        ...items.reduce((acc, item) => {
          if (
            item.items_available > 0 &&
            !itemsNotSeen.map((i) => i.item.item_id).includes(item.item.item_id)
          ) {
            acc.push(item.item.item_id);
          }
          return acc;
        }, []),
      ];

      await Promise.all(
        itemsNotSeen.map((item) =>
          telegram.sendNotification(this.state.telegramConversationIds, item)
        )
      );
      await this.saveState();
      await delay(2000);
      await this.client.getItems({
        paging: { size: 100, page: 0 },
        radius: 1,
        origin: { longitude: 7.188387094360283, latitude: 43.66380495317505 },
        bucket: { filler_type: "FavoritesFlashSales" },
      });
      resolve("done");
    });
  }

  async refreshToken() {
    console.log(
      `[TooGoodToGo] Next refresh at ${moment(this.state.session.lastRefresh)
        .add(this.state.session.accessTokenTtlSeconds, "seconds")
        .format("LLLL")} for ${this.state.user.email}`
    );
    if (
      moment().diff(this.state.session.lastRefresh, "seconds") >
      this.state.session.accessTokenTtlSeconds - 60
    ) {
      const { access_token, access_token_ttl_seconds, refresh_token } =
        await this.client.refreshToken(
          this.state.session.accessToken,
          this.state.session.refreshToken
        );
      console.log("[TooGoodToGo] refreshing token");
      this.state.session = {
        ...this.state.session,
        accessToken: access_token,
        accessTokenTtlSeconds: access_token_ttl_seconds,
        refreshToken: refresh_token,
        lastRefresh: moment(),
      };
      this.client.setBearerToken(access_token);
      await this.saveState();
    }
  }

  async loadState() {
    if (fs.existsSync("./tgtg/state.json")) {
      const state = JSON.parse(fs.readFileSync("./tgtg/state.json"));
      if (Object.keys(state).length && state.constructor === Object) {
        this.state = JSON.parse(fs.readFileSync("./tgtg/state.json"));
      }
      console.log("[TooGoodToGo] state loaded");
    }
  }

  async saveState() {
    await account.updateState(this.state.accountId, this.state);
  }

  async checkPackagesWorkflow() {
    console.log(`[TooGoodToGo] checking packages for ${this.state.user.email}`);
    return new Promise(async (resolve, reject) => {
      let packages = await this.client.getPackages();
      // Remove packages already seen
      packages = packages.filter(
        (p) => p.available_stock > 0 && !this.state.packages.includes(p.item_id)
      );

      if (packages.length) {
        console.log(
          `[TooGoodToGo] found ${packages.length} new packages for ${this.state.user.email}`
        );
      } else {
        console.log(
          `[TooGoodToGo] no new packages for ${this.state.user.email}`
        );
      }

      // Add new packages to packagesSeen
      this.state.packages = [
        ...this.state.packages,
        ...packages.map((p) => p.item_id),
      ];

      await Promise.all(
        packages.map((item) =>
          telegram.sendPackageNotification(
            this.state.telegramConversationIds,
            item
          )
        )
      );
      await this.saveState();
      resolve("done");
    });
  }
}

module.exports = TooGoodToGo;
