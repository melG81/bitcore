import * as async from 'async';
import cors from 'cors';
import express from 'express';
import _ from 'lodash';
import path from 'path';
import 'source-map-support/register';
import config from '../config';
import { Common } from './common';
import { ClientError } from './errors/clienterror';
import { Errors } from './errors/errordefinitions';
import { logger, transport } from './logger';
import { LogMiddleware } from './middleware';
import { WalletService } from './server';
import { Stats } from './stats';

const compression = require('compression');
const RateLimit = require('express-rate-limit');
const rp = require('request-promise-native');
const Defaults = Common.Defaults;

export class ExpressApp {
  app: express.Express;

  constructor() {
    this.app = express();
  }
  /**
   * start
   *
   * @param opts.WalletService options for WalletService class
   * @param opts.basePath
   * @param opts.disableLogs
   * @param opts.doNotCheckV8
   * @param {Callback} cb
   */
  start(opts, cb) {
    opts = opts || {};

    this.app.use(compression());

    this.app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'x-signature,x-identity,x-identities,x-session,x-client-version,x-wallet-id,X-Requested-With,Content-Type,Authorization'
      );
      res.setHeader('x-service-version', WalletService.getServiceVersion());
      next();
    });
    const allowCORS = (req, res, next) => {
      if ('OPTIONS' == req.method) {
        res.sendStatus(200);
        res.end();
        return;
      }
      next();
    };
    this.app.use(allowCORS);
    this.app.enable('trust proxy');

    // handle `abort` https://nodejs.org/api/http.html#http_event_abort
    this.app.use((req, res, next) => {
      req.on('abort', () => {
        logger.warn('Request aborted by the client');
      });
      next();
    });

    const POST_LIMIT = 1024 * 100; // Max POST 100 KB
    const POST_LIMIT_LARGE = 2 * 1024 * 1024; // Max POST 2 MB

    this.app.use((req, res, next) => {
      if (req.path.includes('/txproposals')) {
        // Pushing a lot of utxos to txproposals can make the request much bigger than 100 MB
        return express.json({ limit: POST_LIMIT_LARGE })(req, res, next);
      } else {
        return express.json({ limit: POST_LIMIT })(req, res, next);
      }
    });

    this.app.use((req, res, next) => {
      if (config.maintenanceOpts.maintenanceMode === true) {
        // send a 503 error, with a message to the bitpay status page
        let errorCode = 503;
        let errorMessage = 'BWS down for maintenance';
        res.status(503).send({ code: errorCode, message: errorMessage });
      } else {
        next();
      }
    });

    if (opts.disableLogs) {
      transport.level = 'error';
    } else {
      this.app.use(LogMiddleware());
      // morgan.token('walletId', function getId(req) {
      // return req.walletId ? '<' + req.walletId + '>' : '<>';
      // });

      // const logFormat =
      // ':walletId :remote-addr :date[iso] ":method :url" :status :res[content-length] :response-time ":user-agent"  ';
      // const logOpts = {
      // skip(req, res) {
      // if (res.statusCode != 200) return false;
      // return req.path.indexOf('/notifications/') >= 0;
      // },
      // stream: logger.stream
      // };

      // this.app.use(morgan(logFormat, logOpts));
    }

    const router = express.Router();

    const returnError = (err, res, req) => {
      // make sure headers have not been sent as this leads to an uncaught error
      if (res.headersSent) {
        return;
      }
      if (err instanceof ClientError) {
        const status = err.code == 'NOT_AUTHORIZED' ? 401 : 400;
        if (!opts.disableLogs) logger.info('Client Err: ' + status + ' ' + req.url + ' ' + JSON.stringify(err));

        const clientError: { code: string; message: string; messageData?: object } = {
          code: err.code,
          message: err.message
        };
        if (err.messageData) clientError.messageData = err.messageData;
        res
          .status(status)
          .json(clientError)
          .end();
      } else {
        let code = 500,
          message;
        if (err && ((err.code && _.isNumber(err.code)) || (err.statusCode && _.isNumber(err.statusCode)))) {
          code = err.code || err.statusCode;
          message = err.message || err.body;
        }

        const m = message || err.toString();

        if (!opts.disableLogs) logger.error(req.url + ' :' + code + ':' + m);

        res
          .status(code || 500)
          .json({
            error: m
          })
          .end();
      }
    };

    const logDeprecated = req => {
      logger.warn('DEPRECATED', req.method, req.url, '(' + req.header('x-client-version') + ')');
    };

    const getCredentials = req => {
      const identity = req.header('x-identity');
      if (!identity) return;

      return {
        copayerId: identity,
        signature: req.header('x-signature'),
        session: req.header('x-session')
      };
    };

    const getServer = (req, res): WalletService => {
      const opts = {
        clientVersion: req.header('x-client-version'),
        userAgent: req.header('user-agent')
      };
      return WalletService.getInstance(opts);
    };

    type ServerCallback = (server: WalletService, err?: Error) => void;
    interface ServerOpts { allowSession?: boolean; silentFailure?: boolean; onlySupportStaff?: boolean; onlyMarketingStaff?: boolean }
    const getServerWithAuth = (req, res, opts: ServerOpts | ServerCallback, cb?: ServerCallback | undefined) => {
      if (_.isFunction(opts)) {
        cb = opts;
        opts = {};
      }
      opts = opts || {};

      const credentials = getCredentials(req);
      if (!credentials)
        return returnError(
          new ClientError({
            code: 'NOT_AUTHORIZED'
          }),
          res,
          req
        );

      const auth = {
        copayerId: credentials.copayerId,
        message: req.method.toLowerCase() + '|' + req.url + '|' + JSON.stringify(req.body),
        signature: credentials.signature,
        clientVersion: req.header('x-client-version'),
        userAgent: req.header('user-agent'),
        walletId: req.header('x-wallet-id'),
        session: undefined
      };
      if (opts.allowSession) {
        auth.session = credentials.session;
      }
      WalletService.getInstanceWithAuth(auth, (err, server) => {
        opts = opts as ServerOpts;
        if (err) {
          if (opts.silentFailure) {
            return cb(null, err);
          } else {
            return returnError(err, res, req);
          }
        }

        if (opts.onlySupportStaff && !server.copayerIsSupportStaff) {
          return returnError(
            new ClientError({
              code: 'NOT_AUTHORIZED'
            }),
            res,
            req
          );
        }

        if (server.copayerIsSupportStaff) {
          req.isSupportStaff = true;
        }

        if (opts.onlyMarketingStaff && !server.copayerIsMarketingStaff) {
          return returnError(
            new ClientError({
              code: 'NOT_AUTHORIZED'
            }),
            res,
            req
          );
        }

        // For logging
        req.walletId = server.walletId;
        req.copayerId = server.copayerId;

        return cb(server);
      });
    };

    /**
     * @description process simultaneous requests based on multiple identities that have the same key, hence, the same signature
     * @param {Request} req
     * @param {Response} res
     * @param {Object} opts
     * @returns Array<Promise>
     */
    const getServerWithMultiAuth = (req, res, opts = {}) => {
      const identities = req.headers['x-identities'] ? req.headers['x-identities'].split(',') : false;
      const signature = req.headers['x-signature'];
      if (!identities || !signature) {
        throw new ClientError({ code: 'NOT_AUTHORIZED' });
      }

      if (!Array.isArray(identities)) {
        throw new ClientError({ code: 'NOT_AUTHORIZED' });
      }

      // return a list of promises that we can await or chain
      return identities.map(
        id =>
          new Promise((resolve, reject) =>
            getServerWithAuth(
              Object.assign(req, {
                headers: {
                  ...req.headers,
                  'x-identity': id
                }
              }),
              res,
              opts,
              (server, err) => (err ? reject(err) : resolve(server))
            )
          )
      );
    };

    let createWalletLimiter;

    if (Defaults.RateLimit.createWallet && !opts.ignoreRateLimiter) {
      logger.info(
        'Limiting wallet creation per IP: %o req/h',
        ((Defaults.RateLimit.createWallet.max / Defaults.RateLimit.createWallet.windowMs) * 60 * 60 * 1000).toFixed(2)
      );
      createWalletLimiter = new RateLimit(Defaults.RateLimit.createWallet);
      // router.use(/\/v\d+\/wallets\/$/, createWalletLimiter)
    } else {
      createWalletLimiter = (req, res, next) => {
        next();
      };
    }

    const ONE_MINUTE = 60;
    // See https://support.cloudflare.com/hc/en-us/articles/115003206852-Understanding-Origin-Cache-Control
    // Case: "▶Cache an asset with revalidation, but allow stale responses if origin server is unreachable"
    function SetPublicCache(res: express.Response, seconds: number) {
      res.setHeader('Cache-Control', `public, max-age=${seconds}, stale-if-error=${10 * seconds}`);
    }

    // retrieve latest version of copay
    router.get('/latest-version', async (req, res) => {
      SetPublicCache(res, 10 * ONE_MINUTE);
      try {
        res.setHeader('User-Agent', 'copay');
        var options = {
          uri: 'https://api.github.com/repos/bitpay/wallet/releases/latest',
          headers: {
            'User-Agent': 'Copay'
          },
          json: true
        };

        let server: WalletService;
        try {
          server = getServer(req, res);
        } catch (ex) {
          return returnError(ex, res, req);
        }
        server.storage.checkAndUseGlobalCache(
          'latest-copay-version',
          Defaults.COPAY_VERSION_CACHE_DURATION,
          async (err, version) => {
            if (err) {
              res.send(err);
            }
            if (version) {
              res.json({ version });
            } else {
              try {
                const htmlString = await rp(options);
                if (htmlString['tag_name']) {
                  server.storage.storeGlobalCache('latest-copay-version', htmlString['tag_name'], err => {
                    res.json({ version: htmlString['tag_name'] });
                  });
                }
              } catch (err) {
                res.send(err);
              }
            }
          }
        );
      } catch (err) {
        res.send(err);
      }
    });

    // DEPRECATED
    router.post('/v1/wallets/', createWalletLimiter, (req, res) => {
      logDeprecated(req);
      return returnError(new ClientError('BIP45 wallet creation no longer supported'), res, req);
    });

    router.post('/v2/wallets/', createWalletLimiter, (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.createWallet(req.body, (err, walletId) => {
        if (err) return returnError(err, res, req);
        res.json({
          walletId
        });
      });
    });

    router.put('/v1/copayers/:id/', (req, res) => {
      req.body.copayerId = req.params['id'];
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.addAccess(req.body, (err, result) => {
        if (err) return returnError(err, res, req);
        res.json(result);
      });
    });

    // DEPRECATED
    router.post('/v1/wallets/:id/copayers/', (req, res) => {
      logDeprecated(req);
      return returnError(new ClientError('BIP45 wallet creation no longer supported'), res, req);
    });

    router.post('/v2/wallets/:id/copayers/', (req, res) => {
      req.body.walletId = req.params['id'];
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.joinWallet(req.body, (err, result) => {
        if (err) return returnError(err, res, req);

        res.json(result);
      });
    });

    // DEPRECATED
    router.get('/v1/wallets/', (req, res) => {
      logDeprecated(req);
      getServerWithAuth(req, res, server => {
        server.getStatus(
          {
            includeExtendedInfo: true
          },
          (err, status) => {
            if (err) return returnError(err, res, req);
            res.json(status);
          }
        );
      });
    });

    // DEPRECATED
    router.get('/v2/wallets/', (req, res) => {
      getServerWithAuth(req, res, server => {
        const opts = { includeExtendedInfo: false, twoStep: false };
        if (req.query.includeExtendedInfo == '1') opts.includeExtendedInfo = true;
        if (req.query.twoStep == '1') opts.twoStep = true;

        server.getStatus(opts, (err, status) => {
          if (err) return returnError(err, res, req);
          res.json(status);
        });
      });
    });

    router.get('/v3/wallets/', (req, res) => {
      getServerWithAuth(req, res, server => {
        const opts = {
          includeExtendedInfo: false,
          twoStep: false,
          includeServerMessages: false,
          tokenAddress: req.query.tokenAddress,
          multisigContractAddress: req.query.multisigContractAddress,
          network: req.query.network
        };
        if (req.query.includeExtendedInfo == '1') opts.includeExtendedInfo = true;
        if (req.query.twoStep == '1') opts.twoStep = true;
        if (req.query.serverMessageArray == '1') opts.includeServerMessages = true;
        server.getStatus(opts, (err, status) => {
          if (err) return returnError(err, res, req);
          res.json(status);
        });
      });
    });

    router.get('/v1/wallets/all/', async (req, res) => {
      let responses;

      const buildOpts = (req, copayerId) => {
        const getParam = (param, returnArray = false) => {
          // Handle old client params
          const value = req.query[`${copayerId}:${param}`] || req.query[copayerId]?.[param];
          if (returnArray) {
            return Array.isArray(value) ? value : value ? [value] : null;
          }
          return value ? value : null;
        };
        const opts = {
          includeExtendedInfo: req.query.includeExtendedInfo == '1',
          twoStep: req.query.twoStep == '1',
          silentFailure: req.query.silentFailure == '1',
          includeServerMessages: req.query.serverMessageArray == '1',
          tokenAddresses: getParam('tokenAddress', true),
          multisigContractAddress: getParam('multisigContractAddress'),
          network: getParam('network')
        };
        return opts;
      };

      try {
        responses = await Promise.all(
          getServerWithMultiAuth(req, res, { silentFailure: req.query.silentFailure == '1' }).map(promise =>
            promise.then(
              (server: any) =>
                new Promise(resolve => {
                  let options: any = buildOpts(req, server.copayerId);
                  if (options.tokenAddresses) {
                    // add a null entry to array so we can get the chain balance
                    options.tokenAddresses.unshift(null);
                    return async.concat(
                      options.tokenAddresses,
                      (tokenAddress, cb) => {
                        let optsClone = JSON.parse(JSON.stringify(options));
                        optsClone.tokenAddresses = null;
                        optsClone.tokenAddress = tokenAddress;
                        return server.getStatus(optsClone, (err, status) => {
                          let result: any = {
                            walletId: server.walletId,
                            tokenAddress: optsClone.tokenAddress,
                            success: true,
                            ...(err ? { success: false, message: err.message } : {}),
                            status
                          };
                          if (err && err.message)
                            logger.error(
                              `An error occurred retrieving wallet status - id: ${server.walletId} - token address: ${optsClone.tokenAddress} - err: ${err.message}`
                            );
                          cb(null, result); // do not throw error, continue with next wallets
                        });
                      },
                      (err, result) => {
                        return resolve(result);
                      }
                    );
                  } else {
                    return server.getStatus(options, (err, status) => {
                      return resolve([
                        {
                          walletId: server.walletId,
                          tokenAddress: null,
                          success: true,
                          ...(err ? { success: false, message: err.message } : {}),
                          status
                        }
                      ]);
                    });
                  }
                }),
              ({ message }) => Promise.resolve({ success: false, error: message })
            )
          )
        );
      } catch (err) {
        return returnError(err, res, req);
      }

      return res.json(_.flatten(responses));
    });

    router.get('/v1/wallets/:identifier/', (req, res) => {
      getServerWithAuth(
        req,
        res,
        {
          onlySupportStaff: true
        },
        server => {
          const opts = {
            identifier: req.params['identifier'],
            walletCheck: ['1', 'true'].includes(req.query['walletCheck'])
          };
          server.getWalletFromIdentifier(opts, (err, wallet) => {
            if (err) return returnError(err, res, req);
            if (!wallet) return res.end();

            server.walletId = wallet.id;
            const opts = { includeExtendedInfo: false };
            if (req.query.includeExtendedInfo == '1') opts.includeExtendedInfo = true;
            server.getStatus(opts, (err, status) => {
              if (err) return returnError(err, res, req);
              res.json(status);
            });
          });
        }
      );
    });

    router.get('/v1/preferences/', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.getPreferences({}, (err, preferences) => {
          if (err) return returnError(err, res, req);
          res.json(preferences);
        });
      });
    });

    router.put('/v1/preferences', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.savePreferences(req.body, (err, result) => {
          if (err) return returnError(err, res, req);
          res.json(result);
        });
      });
    });

    // DEPRECATED (do not use cashaddr)
    router.get('/v1/txproposals/', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.getPendingTxs({ noCashAddr: true }, (err, pendings) => {
          if (err) return returnError(err, res, req);
          res.json(pendings);
        });
      });
    });

    router.get('/v2/txproposals/', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.getPendingTxs({}, (err, pendings) => {
          if (err) return returnError(err, res, req);
          res.json(pendings);
        });
      });
    });

    // DEPRECATED
    router.post('/v1/txproposals/', (req, res) => {
      const err = Errors.UPGRADE_NEEDED;
      return returnError(err, res, req);
    });

    // DEPRECATED, no cash addr
    router.post('/v2/txproposals/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.noCashAddr = true;
        req.body.txpVersion = 3;
        server.createTx(req.body, (err, txp) => {
          if (err) return returnError(err, res, req);
          res.json(txp);
        });
      });
    });

    router.post('/v3/txproposals/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.txpVersion = 3;
        server.createTx(req.body, (err, txp) => {
          if (err) return returnError(err, res, req);
          res.json(txp);
        });
      });
    });

    // create advertisement
    router.post('/v1/advertisements/', (req, res) => {
      getServerWithAuth(
        req,
        res,
        {
          onlyMarketingStaff: true
        },
        server => {
          server.createAdvert(req.body, (err, advert) => {
            if (err) {
              return returnError(err, res, req);
            }
            if (advert) res.json(advert);
          });
        }
      );
    });

    router.get('/v1/advertisements/', (req, res) => {
      let server: WalletService;
      let testing = req.query.testing;

      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      if (testing) {
        server.getTestingAdverts(req.body, (err, ads) => {
          if (err) returnError(err, res, req);
          res.json(ads);
        });
      } else {
        SetPublicCache(res, 5 * ONE_MINUTE);
        server.getAdverts(req.body, (err, ads) => {
          if (err) returnError(err, res, req);
          res.json(ads);
        });
      }
    });

    router.get('/v1/advertisements/:adId/', (req, res) => {
      let server: WalletService;

      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      let opts = { adId: req.params['adId'] };

      if (req.params['adId']) {
        server.getAdvert(opts, (err, ad) => {
          if (err) returnError(err, res, req);
          res.json(ad);
        });
      }
    });

    router.get('/v1/advertisements/country/:country', (req, res) => {
      let server: WalletService;
      let country = req.params['country'];

      let opts = { country };

      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.getAdvertsByCountry(opts, (err, ads) => {
        if (err) returnError(err, res, req);
        res.json(ads);
      });
    });

    router.post('/v1/advertisements/:adId/activate', (req, res) => {
      let opts = { adId: req.params['adId'] };

      getServerWithAuth(
        req,
        res,
        {
          onlyMarketingStaff: true
        },
        server => {
          if (req.params['adId']) {
            server.activateAdvert(opts, (err, ad) => {
              if (err) returnError(err, res, req);
              res.json({ advertisementId: opts.adId, message: 'advert activated' });
            });
          }
        }
      );
    });

    router.post('/v1/advertisements/:adId/deactivate', (req, res) => {
      let opts = { adId: req.params['adId'] };

      getServerWithAuth(
        req,
        res,
        {
          onlyMarketingStaff: true
        },
        server => {
          if (req.params['adId']) {
            server.deactivateAdvert(opts, (err, ad) => {
              if (err) returnError(err, res, req);
              res.json({ advertisementId: opts.adId, message: 'advert deactivated' });
            });
          }
        }
      );
    });

    router.delete('/v1/advertisements/:adId/', (req, res) => {
      getServerWithAuth(
        req,
        res,
        {
          onlyMarketingStaff: true
        },
        server => {
          req.body.adId = req.params['adId'];
          server.removeAdvert(req.body, (err, removedAd) => {
            if (err) returnError(err, res, req);
            if (removedAd) {
              res.json(removedAd);
            }
          });
        }
      );
    });

    /* THIS WAS NEVED ENABLED YET NOW 2020-04-07
    router.post('/v4/txproposals/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.txpVersion = 4;
        server.createTx(req.body, (err, txp) => {
          if (err) return returnError(err, res, req);
          res.json(txp);
        });
      });
    });

*/

    // DEPRECATED
    router.post('/v1/addresses/', (req, res) => {
      logDeprecated(req);
      getServerWithAuth(req, res, server => {
        server.createAddress(
          {
            ignoreMaxGap: true
          },
          (err, address) => {
            if (err) return returnError(err, res, req);
            res.json(address);
          }
        );
      });
    });

    // DEPRECATED
    router.post('/v2/addresses/', (req, res) => {
      logDeprecated(req);
      getServerWithAuth(req, res, server => {
        server.createAddress(
          {
            ignoreMaxGap: true
          },
          (err, address) => {
            if (err) return returnError(err, res, req);
            res.json(address);
          }
        );
      });
    });

    // DEPRECATED (no cashaddr by default)
    router.post('/v3/addresses/', (req, res) => {
      getServerWithAuth(req, res, server => {
        let opts = req.body;
        opts = opts || {};
        opts.noCashAddr = true;
        server.createAddress(opts, (err, address) => {
          if (err) return returnError(err, res, req);
          res.json(address);
        });
      });
    });

    router.post('/v4/addresses/', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.createAddress(req.body, (err, address) => {
          if (err) return returnError(err, res, req);
          res.json(address);
        });
      });
    });

    router.get('/v1/addresses/', (req, res) => {
      getServerWithAuth(req, res, server => {
        const opts: { limit?: number; reverse?: boolean; skip?: number } = {};
        if (req.query.limit) opts.limit = +req.query.limit;
        if (req.query.skip) opts.skip = +req.query.skip;
        opts.reverse = req.query.reverse == '1';

        server.getMainAddresses(opts, (err, addresses) => {
          if (err) return returnError(err, res, req);
          res.json(addresses);
        });
      });
    });

    router.get('/v1/balance/', (req, res) => {
      getServerWithAuth(req, res, server => {
        const opts: { coin?: string; twoStep?: boolean; tokenAddress?: string; multisigContractAddress?: string } = {};
        if (req.query.coin) opts.coin = req.query.coin as string;
        if (req.query.twoStep == '1') opts.twoStep = true;
        if (req.query.tokenAddress) opts.tokenAddress = req.query.tokenAddress as string;
        if (req.query.multisigContractAddress)
          opts.multisigContractAddress = req.query.multisigContractAddress as string;

        server.getBalance(opts, (err, balance) => {
          if (err) return returnError(err, res, req);
          res.json(balance);
        });
      });
    });

    let estimateFeeLimiter;

    if (Defaults.RateLimit.estimateFee && !opts.ignoreRateLimiter) {
      logger.info(
        'Limiting estimate fee per IP: %o req/h',
        ((Defaults.RateLimit.estimateFee.max / Defaults.RateLimit.estimateFee.windowMs) * 60 * 60 * 1000).toFixed(2)
      );
      estimateFeeLimiter = new RateLimit(Defaults.RateLimit.estimateFee);
      // router.use(/\/v\d+\/wallets\/$/, createWalletLimiter)
    } else {
      estimateFeeLimiter = (req, res, next) => {
        next();
      };
    }

    // DEPRECATED
    router.get('/v1/feelevels/', estimateFeeLimiter, (req, res) => {
      SetPublicCache(res, 1 * ONE_MINUTE);
      logDeprecated(req);
      const opts: { network?: string } = {};
      if (req.query.network) opts.network = req.query.network as string;
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.getFeeLevels(opts, (err, feeLevels) => {
        if (err) return returnError(err, res, req);
        _.each(feeLevels, feeLevel => {
          feeLevel.feePerKB = feeLevel.feePerKb;
          delete feeLevel.feePerKb;
        });
        res.json(feeLevels);
      });
    });

    router.get('/v2/feelevels/', (req, res) => {
      const opts: { coin?: string; network?: string; chain?: string } = {};
      SetPublicCache(res, 1 * ONE_MINUTE);

      if (req.query.coin) opts.coin = req.query.coin as string;
      if (req.query.chain || req.query.coin) opts.chain = (req.query.chain || req.query.coin) as string;
      if (req.query.network) opts.network = req.query.network as string;

      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.getFeeLevels(opts, (err, feeLevels) => {
        if (err) return returnError(err, res, req);
        res.json(feeLevels);
      });
    });

    router.post('/v3/estimateGas/', (req, res) => {
      getServerWithAuth(req, res, async server => {
        try {
          const gasLimit = await server.estimateGas(req.body);
          res.json(gasLimit);
        } catch (err) {
          returnError(err, res, req);
        }
      });
    });

    // DEPRECATED
    router.post('/v1/ethmultisig/', (req, res) => {
      getServerWithAuth(req, res, async server => {
        try {
          const multisigContractInstantiationInfo = await server.getMultisigContractInstantiationInfo(req.body);
          res.json(multisigContractInstantiationInfo);
        } catch (err) {
          returnError(err, res, req);
        }
      });
    });

    // DEPRECATED
    router.post('/v1/ethmultisig/info', (req, res) => {
      getServerWithAuth(req, res, async server => {
        try {
          const multisigContractInfo = await server.getMultisigContractInfo(req.body);
          res.json(multisigContractInfo);
        } catch (err) {
          returnError(err, res, req);
        }
      });
    });

    router.post('/v1/multisig/', (req, res) => {
      getServerWithAuth(req, res, async server => {
        try {
          const multisigContractInstantiationInfo = await server.getMultisigContractInstantiationInfo(req.body);
          res.json(multisigContractInstantiationInfo);
        } catch (err) {
          returnError(err, res, req);
        }
      });
    });

    router.post('/v1/multisig/info', (req, res) => {
      getServerWithAuth(req, res, async server => {
        try {
          const multisigContractInfo = await server.getMultisigContractInfo(req.body);
          res.json(multisigContractInfo);
        } catch (err) {
          returnError(err, res, req);
        }
      });
    });

    router.post('/v1/token/info', (req, res) => {
      getServerWithAuth(req, res, async server => {
        try {
          const tokenContractInfo = await server.getTokenContractInfo(req.body);
          res.json(tokenContractInfo);
        } catch (err) {
          returnError(err, res, req);
        }
      });
    });

    router.get('/v1/sendmaxinfo/', (req, res) => {
      getServerWithAuth(req, res, server => {
        const q = req.query;
        const opts: {
          feePerKb?: number;
          feeLevel?: number;
          returnInputs?: boolean;
          excludeUnconfirmedUtxos?: boolean;
        } = {};
        if (q.feePerKb) opts.feePerKb = +q.feePerKb;
        if (q.feeLevel) opts.feeLevel = Number(q.feeLevel);
        if (q.excludeUnconfirmedUtxos == '1') opts.excludeUnconfirmedUtxos = true;
        if (q.returnInputs == '1') opts.returnInputs = true;
        server.getSendMaxInfo(opts, (err, info) => {
          if (err) return returnError(err, res, req);
          res.json(info);
        });
      });
    });

    router.get('/v1/utxos/', (req, res) => {
      const opts: { addresses?: string[] } = {};
      const addresses = req.query.addresses;
      if (addresses && _.isString(addresses)) opts.addresses = (req.query.addresses as string).split(',');
      getServerWithAuth(req, res, server => {
        server.getUtxos(opts, (err, utxos) => {
          if (err) return returnError(err, res, req);
          res.json(utxos);
        });
      });
    });

    router.get('/v1/txcoins/', (req, res) => {
      const txId = req.query.txId;
      getServerWithAuth(req, res, server => {
        server.getCoinsForTx({ txId }, (err, coins) => {
          if (err) return returnError(err, res, req);
          res.json(coins);
        });
      });
    });

    router.post('/v1/broadcast_raw/', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.broadcastRawTx(req.body, (err, txid) => {
          if (err) return returnError(err, res, req);
          res.json(txid);
          res.end();
        });
      });
    });

    // DEPRECATEED
    router.post('/v1/txproposals/:id/signatures/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.maxTxpVersion = 3;
        req.body.txProposalId = req.params['id'];
        server.signTx(req.body, (err, txp) => {
          if (err) return returnError(err, res, req);
          res.json(txp);
          res.end();
        });
      });
    });

    // We created a new endpoint that support BCH schnorr signatues
    // so we can safely throw the error "UPGRADE NEEDED" if an old
    // client tries to post ECDSA signatures to a Schnorr TXP.
    // (using the old /v1/txproposal method): if (txp.signingMethod === 'schnorr' && !opts.supportBchSchnorr) return cb(Errors.UPGRADE_NEEDED);
    router.post('/v2/txproposals/:id/signatures/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.txProposalId = req.params['id'];
        req.body.maxTxpVersion = 3;
        req.body.supportBchSchnorr = true;
        server.signTx(req.body, (err, txp) => {
          if (err) return returnError(err, res, req);
          res.json(txp);
          res.end();
        });
      });
    });

    /* THIS WAS NEVED ENABLED YET NOW 2020-04-07 (see above)
    router.post('/v3/txproposals/:id/signatures/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.txProposalId = req.params['id'];
        req.body.maxTxpVersion = 4;
        server.signTx(req.body, (err, txp) => {
          if (err) return returnError(err, res, req);
          res.json(txp);
          res.end();
        });
      });
    });
    */

    //
    router.post('/v1/txproposals/:id/publish/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.txProposalId = req.params['id'];
        req.body.noCashAddr = true;
        server.publishTx(req.body, (err, txp) => {
          if (err) return returnError(err, res, req);
          res.json(txp);
          res.end();
        });
      });
    });

    router.post('/v2/txproposals/:id/publish/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.txProposalId = req.params['id'];
        server.publishTx(req.body, (err, txp) => {
          if (err) return returnError(err, res, req);
          res.json(txp);
          res.end();
        });
      });
    });

    // TODO Check HTTP verb and URL name
    router.post('/v1/txproposals/:id/broadcast/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.txProposalId = req.params['id'];
        server.broadcastTx(req.body, (err, txp) => {
          if (err) return returnError(err, res, req);
          res.json(txp);
          res.end();
        });
      });
    });

    router.post('/v1/txproposals/:id/rejections', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.txProposalId = req.params['id'];
        server.rejectTx(req.body, (err, txp) => {
          if (err) return returnError(err, res, req);
          res.json(txp);
          res.end();
        });
      });
    });

    router.delete('/v1/txproposals/:id/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.txProposalId = req.params['id'];
        server.removePendingTx(req.body, err => {
          if (err) return returnError(err, res, req);
          res.json({
            success: true
          });
          res.end();
        });
      });
    });

    router.get('/v1/txproposals/:id/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.txProposalId = req.params['id'];
        server.getTx(req.body, (err, tx) => {
          if (err) return returnError(err, res, req);
          res.json(tx);
          res.end();
        });
      });
    });

    router.get('/v1/txproposalsbyhash/:id/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body.txid = req.params['id'];
        server.getTxByHash(req.body, (err, tx) => {
          if (err) return returnError(err, res, req);
          res.json(tx);
          res.end();
        });
      });
    });

    router.get('/v1/txhistory/', (req, res) => {
      getServerWithAuth(req, res, server => {
        const opts: {
          skip?: number;
          limit?: number;
          includeExtendedInfo?: boolean;
          tokenAddress?: string;
          multisigContractAddress?: string;
        } = {};
        if (req.query.skip) opts.skip = +req.query.skip;
        if (req.query.limit) opts.limit = +req.query.limit;
        if (req.query.tokenAddress) opts.tokenAddress = req.query.tokenAddress as string;
        if (req.query.multisigContractAddress)
          opts.multisigContractAddress = req.query.multisigContractAddress as string;
        if (req.query.includeExtendedInfo == '1') opts.includeExtendedInfo = true;

        server.getTxHistory(opts, (err, txs) => {
          if (err) return returnError(err, res, req);
          res.json(txs);
          res.end();
        });
      });
    });

    router.post('/v1/addresses/scan/', (req, res) => {
      getServerWithAuth(req, res, server => {
        req.body = req.body || {};
        req.body.startIdx = server.copayerIsSupportStaff ? Number(req.body.startIdx) : null;
        server.startScan(req.body, (err, started) => {
          if (err) return returnError(err, res, req);
          res.json(started);
          res.end();
        });
      });
    });

    // Retrive stats DO NOT UPDATE THEM
    // To update them run /updatestats
    router.get('/v1/stats/', (req, res) => {
      SetPublicCache(res, 1 * ONE_MINUTE);
      const opts: {
        network?: string;
        coin?: string;
        from?: string;
        to?: string;
      } = {};

      if (req.query.network) opts.network = req.query.network as string;
      if (req.query.coin) opts.coin = req.query.coin as string;
      if (req.query.from) opts.from = req.query.from as string;
      if (req.query.to) opts.to = req.query.to as string;

      const stats = new Stats(opts);
      stats.run((err, data) => {
        if (err) return returnError(err, res, req);
        res.json(data);
        res.end();
      });
    });

    router.get('/v1/version/', (req, res) => {
      SetPublicCache(res, 1 * ONE_MINUTE);
      res.json({
        serviceVersion: WalletService.getServiceVersion()
      });
      res.end();
    });

    router.post('/v1/login/', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.login({}, (err, session) => {
          if (err) return returnError(err, res, req);
          res.json(session);
        });
      });
    });

    router.post('/v1/logout/', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.logout({}, err => {
          if (err) return returnError(err, res, req);
          res.end();
        });
      });
    });

    router.get('/v1/notifications/', (req, res) => {
      getServerWithAuth(
        req,
        res,
        {
          allowSession: true
        },
        server => {
          const timeSpan = req.query.timeSpan
            ? Math.min(+req.query.timeSpan || 0, Defaults.MAX_NOTIFICATIONS_TIMESPAN)
            : Defaults.NOTIFICATIONS_TIMESPAN;
          const opts = {
            minTs: +Date.now() - timeSpan * 1000,
            notificationId: req.query.notificationId
          };

          server.getNotifications(opts, (err, notifications) => {
            if (err) return returnError(err, res, req);
            res.json(notifications);
          });
        }
      );
    });

    router.get('/v1/txnotes/:txid', (req, res) => {
      getServerWithAuth(req, res, server => {
        const opts = {
          txid: req.params['txid']
        };
        server.getTxNote(opts, (err, note) => {
          if (err) return returnError(err, res, req);
          res.json(note);
        });
      });
    });

    router.put('/v1/txnotes/:txid/', (req, res) => {
      req.body.txid = req.params['txid'];
      getServerWithAuth(req, res, server => {
        server.editTxNote(req.body, (err, note) => {
          if (err) return returnError(err, res, req);
          res.json(note);
        });
      });
    });

    router.get('/v1/txnotes/', (req, res) => {
      getServerWithAuth(req, res, server => {
        const opts: { minTs?: number } = {};
        if (req.query.minTs && _.isNumber(+req.query.minTs)) {
          opts.minTs = +req.query.minTs;
        }
        server.getTxNotes(opts, (err, notes) => {
          if (err) return returnError(err, res, req);
          res.json(notes);
        });
      });
    });

    router.get('/v1/nonce/:address', (req, res) => {
      getServerWithAuth(req, res, async server => {
        const opts = {
          coin: req.query.coin || 'eth',
          chain: req.query.chain,
          network: req.query.network || 'livenet',
          address: req.params['address']
        };
        try {
          const nonce = await server.getNonce(opts);
          res.json(nonce);
        } catch (err) {
          returnError(err, res, req);
        }
      });
    });

    router.post('/v1/clearcache/', (req, res) => {
      getServerWithAuth(req, res, server => {
        const opts = req.query;
        server.clearWalletCache(opts).then(val => {
          if (val) {
            res.sendStatus(200);
          } else {
            res.sendStatus(500);
          }
        });
      });
    });

    router.get('/v1/fiatrates/:code/', (req, res) => {
      SetPublicCache(res, 5 * ONE_MINUTE);
      let server: WalletService;
      const opts = {
        code: req.params['code'],
        coin: req.query.coin || 'btc',
        ts: req.query.ts ? +req.query.ts : null
      };
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.getFiatRate(opts, (err, rates) => {
        if (err) return returnError(err, res, req);
        res.json(rates);
      });
    });

    router.get('/v2/fiatrates/:code/', (req, res) => {
      SetPublicCache(res, 5 * ONE_MINUTE);
      let server: WalletService;
      const opts = {
        code: req.params['code'],
        ts: req.query.ts ? +req.query.ts : null
      };
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.getHistoricalRates(opts, (err, rates) => {
        if (err) return returnError(err, res, req);
        res.json(rates);
      });
    });

    router.get('/v3/fiatrates/', (req, res) => {
      SetPublicCache(res, 5 * ONE_MINUTE);
      let server: WalletService;
      const opts = {
        code: req.query.code || null,
        ts: req.query.ts ? +req.query.ts : null
      };
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.getFiatRates(opts, (err, rates) => {
        if (err) return returnError(err, res, req);
        res.json(rates);
      });
    });

    router.get('/v3/fiatrates/:coin/', (req, res) => {
      SetPublicCache(res, 5 * ONE_MINUTE);
      let server: WalletService;
      const opts = {
        coin: req.params['coin'],
        code: req.query.code || null,
        ts: req.query.ts ? +req.query.ts : null
      };
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.getFiatRatesByCoin(opts, (err, rates) => {
        if (err) return returnError(err, res, req);
        res.json(rates);
      });
    });

    // DEPRECATED
    router.post('/v1/pushnotifications/subscriptions/', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.pushNotificationsSubscribe(req.body, (err, response) => {
          if (err) return returnError(err, res, req);
          res.json(response);
        });
      });
    });

    router.post('/v2/pushnotifications/subscriptions/', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.pushNotificationsBrazeSubscribe(req.body, (err, response) => {
          if (err) return returnError(err, res, req);
          res.json(response);
        });
      });
    });

    // DEPRECATED
    router.delete('/v1/pushnotifications/subscriptions/', (req, res) => {
      logDeprecated(req);
      getServerWithAuth(req, res, server => {
        server.pushNotificationsUnsubscribe(
          {
            token: 'dummy'
          },
          (err, response) => {
            if (err) return returnError(err, res, req);
            res.json(response);
          }
        );
      });
    });

    // DEPRECATED
    router.delete('/v2/pushnotifications/subscriptions/:token', (req, res) => {
      const opts = {
        token: req.params['token']
      };
      getServerWithAuth(req, res, server => {
        server.pushNotificationsUnsubscribe(opts, (err, response) => {
          if (err) return returnError(err, res, req);
          res.json(response);
        });
      });
    });

    router.delete('/v3/pushnotifications/subscriptions/:externalUserId', (req, res) => {
      const opts = {
        externalUserId: req.params['externalUserId']
      };
      getServerWithAuth(req, res, server => {
        server.pushNotificationsBrazeUnsubscribe(opts, (err, response) => {
          if (err) return returnError(err, res, req);
          res.json(response);
        });
      });
    });

    router.post('/v1/txconfirmations/', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.txConfirmationSubscribe(req.body, (err, response) => {
          if (err) return returnError(err, res, req);
          res.json(response);
        });
      });
    });

    router.delete('/v1/txconfirmations/:txid', (req, res) => {
      const opts = {
        txid: req.params['txid']
      };
      getServerWithAuth(req, res, server => {
        server.txConfirmationUnsubscribe(opts, (err, response) => {
          if (err) return returnError(err, res, req);
          res.json(response);
        });
      });
    });

    router.get('/v1/services', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      const opts = req.query;
      server.getServicesData(opts, (err, response) => {
        if (err) return returnError(err, res, req);
        res.json(response);
      });
    });

    router.post('/v1/service/checkAvailability', (req, res) => {
      let server: WalletService, response;
      try {
        server = getServer(req, res);
        response = server.checkServiceAvailability(req);
        return res.json(response);
      } catch (ex) {
        return returnError(ex, res, req);
      }
    });

    router.post('/v1/service/banxa/getCoins', async (req, res) => {
      let server: WalletService, response;
      try {
        server = getServer(req, res);
        response = await server.externalServices.banxa.banxaGetCoins(req);
        return res.json(response);
      } catch (ex) {
        return returnError(ex, res, req);
      }
    });

    router.post('/v1/service/banxa/paymentMethods', async (req, res) => {
      let server: WalletService, response;
      try {
        server = getServer(req, res);
        response = await server.externalServices.banxa.banxaGetPaymentMethods(req);
        return res.json(response);
      } catch (ex) {
        return returnError(ex, res, req);
      }
    });

    router.post('/v1/service/banxa/quote', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.banxa.banxaGetQuote(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/banxa/createOrder', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.banxa.banxaCreateOrder(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/banxa/getOrder', async (req, res) => {
      let server: WalletService, response;
      try {
        server = getServer(req, res);
        response = await server.externalServices.banxa.banxaGetOrder(req);
        return res.json(response);
      } catch (ex) {
        return returnError(ex, res, req);
      }
    });

    router.post('/v1/service/moonpay/getCurrencies', async (req, res) => {
      let server: WalletService, response;
      try {
        server = getServer(req, res);
        response = await server.externalServices.moonpay.moonpayGetCurrencies(req);
        return res.json(response);
      } catch (ex) {
        return returnError(ex, res, req);
      }
    });

    router.post('/v1/service/moonpay/quote', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.moonpay.moonpayGetQuote(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/moonpay/sellQuote', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.moonpay.moonpayGetSellQuote(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/moonpay/currencyLimits', async (req, res) => {
      let server: WalletService, response;
      try {
        server = getServer(req, res);
        response = await server.externalServices.moonpay.moonpayGetCurrencyLimits(req);
        return res.json(response);
      } catch (ex) {
        return returnError(ex, res, req);
      }
    });

    router.post('/v1/service/moonpay/signedPaymentUrl', (req, res) => {
      getServerWithAuth(req, res, server => {
        let response;
        try {
          response = server.externalServices.moonpay.moonpayGetSignedPaymentUrl(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/moonpay/sellSignedPaymentUrl', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.moonpay.moonpayGetSellSignedPaymentUrl(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/moonpay/transactionDetails', async (req, res) => {
      let server: WalletService, response;
      try {
        server = getServer(req, res);
        response = await server.externalServices.moonpay.moonpayGetTransactionDetails(req);
        return res.json(response);
      } catch (ex) {
        return returnError(ex, res, req);
      }
    });

    router.post('/v1/service/moonpay/sellTransactionDetails', async (req, res) => {
      let server: WalletService, response;
      try {
        server = getServer(req, res);
        response = await server.externalServices.moonpay.moonpayGetSellTransactionDetails(req);
        return res.json(response);
      } catch (ex) {
        return returnError(ex, res, req);
      }
    });

    router.post('/v1/service/moonpay/cancelSellTransaction', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.moonpay.moonpayCancelSellTransaction(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/moonpay/accountDetails', async (req, res) => {
      let server: WalletService, response;
      try {
        server = getServer(req, res);
        response = await server.externalServices.moonpay.moonpayGetAccountDetails(req);
        return res.json(response);
      } catch (ex) {
        return returnError(ex, res, req);
      }
    });

    router.post('/v1/service/ramp/quote', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.ramp.rampGetQuote(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/ramp/sellQuote', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.ramp.rampGetSellQuote(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/ramp/signedPaymentUrl', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.ramp.rampGetSignedPaymentUrl(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/ramp/assets', async (req, res) => {
      let server: WalletService, response;
      try {
        server = getServer(req, res);
        response = await server.externalServices.ramp.rampGetAssets(req);
        return res.json(response);
      } catch (ex) {
        return returnError(ex, res, req);
      }
    });

    router.post('/v1/service/ramp/sellTransactionDetails', async (req, res) => {
      let server, response;
      try {
        server = getServer(req, res);
        response = await server.externalServices.ramp.rampGetSellTransactionDetails(req);
        return res.json(response);
      } catch (ex) {
        return returnError(ex, res, req);
      }
    });

    router.post('/v1/service/sardine/quote', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.externalServices.sardine
          .sardineGetQuote(req)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.post('/v1/service/sardine/getToken', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.externalServices.sardine
          .sardineGetToken(req)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.post('/v1/service/sardine/getSupportedTokens', async (req, res) => {
      let server: WalletService, response;
      try {
        server = getServer(req, res);
        response = await server.externalServices.sardine.sardineGetSupportedTokens(req);
        return res.json(response);
      } catch (ex) {
        return returnError(ex, res, req);
      }
    });

    router.post('/v1/service/sardine/currencyLimits', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.externalServices.sardine
        .sardineGetCurrencyLimits(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/service/sardine/ordersDetails', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.externalServices.sardine
        .sardineGetOrdersDetails(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/service/simplex/getCurrencies', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.externalServices.simplex
        .simplexGetCurrencies(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/service/simplex/quote', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.externalServices.simplex
          .simplexGetQuote(req)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.post('/v1/service/simplex/sellQuote', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.externalServices.simplex
          .simplexGetSellQuote(req)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.post('/v1/service/simplex/paymentRequest', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.externalServices.simplex
          .simplexPaymentRequest(req)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.post('/v1/service/simplex/sellPaymentRequest', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.externalServices.simplex
          .simplexSellPaymentRequest(req)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.get('/v1/service/simplex/events', (req, res) => {
      getServerWithAuth(req, res, server => {
        const opts = { env: req.query.env };
        server.externalServices.simplex
          .simplexGetEvents(opts)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.post('/v1/service/thorswap/supportedChains', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.externalServices.thorswap
        .thorswapGetSupportedChains(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/service/thorswap/cryptoCurrencies', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.externalServices.thorswap
        .thorswapGetCryptoCurrencies(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/service/thorswap/getSwapQuote', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.thorswap.thorswapGetSwapQuote(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/thorswap/getSwapTx', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.externalServices.thorswap
        .thorswapGetSwapTx(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/service/transak/getAccessToken', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.transak.transakGetAccessToken(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/transak/cryptoCurrencies', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.externalServices.transak
        .transakGetCryptoCurrencies(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/service/transak/fiatCurrencies', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.externalServices.transak
        .transakGetFiatCurrencies(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/service/transak/quote', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.transak.transakGetQuote(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/transak/signedPaymentUrl', (req, res) => {
      getServerWithAuth(req, res, async server => {
        let response;
        try {
          response = await server.externalServices.transak.transakGetSignedPaymentUrl(req);
          return res.json(response);
        } catch (ex) {
          return returnError(ex, res, req);
        }
      });
    });

    router.post('/v1/service/transak/orderDetails', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.externalServices.transak
        .transakGetOrderDetails(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/service/wyre/walletOrderQuotation', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.externalServices.wyre
          .wyreWalletOrderQuotation(req)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.post('/v1/service/wyre/walletOrderReservation', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.externalServices.wyre
          .wyreWalletOrderReservation(req)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.post('/v1/service/changelly/getCurrencies', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.externalServices.changelly
        .changellyGetCurrencies(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/service/changelly/getPairsParams', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.externalServices.changelly
          .changellyGetPairsParams(req)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.post('/v1/service/changelly/getFixRateForAmount', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.externalServices.changelly
          .changellyGetFixRateForAmount(req)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.post('/v1/service/changelly/createFixTransaction', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.externalServices.changelly
          .changellyCreateFixTransaction(req)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.post('/v1/service/changelly/getTransactions', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.externalServices.changelly
        .changellyGetTransactions(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/service/changelly/getStatus', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.externalServices.changelly
        .changellyGetStatus(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.get('/v1/service/oneInch/getReferrerFee', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.externalServices.oneInch
        .oneInchGetReferrerFee(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/service/oneInch/getSwap/:chain?', (req, res) => {
      getServerWithAuth(req, res, server => {
        server.externalServices.oneInch
          .oneInchGetSwap(req)
          .then(response => {
            res.json(response);
          })
          .catch(err => {
            return returnError(err ?? 'unknown', res, req);
          });
      });
    });

    router.get('/v1/service/oneInch/getTokens/:chain?', (req, res) => {
      SetPublicCache(res, 1 * ONE_MINUTE);
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server.coinGeckoGetTokens(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.get('/v1/services/dex/getSpenderApprovalWhitelist', (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.getSpenderApprovalWhitelist((err, response) => {
        if (err) return returnError(err, res, req);
        res.json(response);
      });
    });

    router.get('/v1/service/payId/:payId', (req, res) => {
      let server: WalletService;
      const payId = req.params['payId'];
      const opts = {
        handle: payId.split('$')[0],
        domain: payId.split('$')[1]
      };
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server
        .discoverPayId(opts)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    const moralisCorsOptions = {
      origin: (origin, cb) => {
        const moralisWhiteList = config.moralis?.whitelist ?? [];
        if (moralisWhiteList.indexOf(origin) !== -1) {
          cb(null, true);
        } else {
          cb(new Error('Not allowed by CORS'));
        }
      },
    };

    router.post('/v1/moralis/getWalletTokenBalances', cors(moralisCorsOptions), (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.moralisGetWalletTokenBalances(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/moralis/moralisGetTokenAllowance', cors(moralisCorsOptions), (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.moralisGetTokenAllowance(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/moralis/moralisGetNativeBalance', cors(moralisCorsOptions), (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.moralisGetNativeBalance(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/moralis/GetTokenPrice', cors(moralisCorsOptions), (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.moralisGetTokenPrice(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/moralis/getMultipleERC20TokenPrices', cors(moralisCorsOptions), (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.moralisGetMultipleERC20TokenPrices(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/moralis/getERC20TokenBalancesWithPricesByWallet', cors(moralisCorsOptions), (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.moralisGetERC20TokenBalancesWithPricesByWallet(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    router.post('/v1/moralis/getSolWalletPortfolio', cors(moralisCorsOptions), (req, res) => {
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }

      server.moralisGetSolWalletPortfolio(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });    

    router.get('/v1/service/coinGecko/getRates/:contractAddresses/:altCurrencies/:chain', (req, res) => {
      SetPublicCache(res, 1 * ONE_MINUTE);
      let server: WalletService;
      try {
        server = getServer(req, res);
      } catch (ex) {
        return returnError(ex, res, req);
      }
      server
        .coinGeckoGetRates(req)
        .then(response => {
          res.json(response);
        })
        .catch(err => {
          return returnError(err ?? 'unknown', res, req);
        });
    });

    // Set no-cache by default
    this.app.use((req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    });

    const staticPath = path.join(__dirname, '../../static');
    this.app.use('/bws/static', express.static(staticPath));

    this.app.use(opts.basePath || '/bws/api', router);

    if (config.staticRoot) {
      logger.debug(`Serving static files from ${config.staticRoot}`);
      this.app.use('/static', express.static(config.staticRoot));
    }

    WalletService.initialize(opts, cb);
  }
}
