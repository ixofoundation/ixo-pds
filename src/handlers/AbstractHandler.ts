import { Model, connection } from "mongoose";
import { ITransactionModel } from '../model/project/Transaction';
import { ICapabilitiesModel } from '../model/project/Capabilities';

import transactionService from '../service/TransactionLogService';
import capabilitiesService from '../service/CapabilitiesService';
import walletService from '../service/WalletService';

import { RequestValidator } from '../templates/RequestValidator';
import { validateJson } from '../templates/JsonValidator';
import { ValidatorResult } from 'jsonschema';
import { ValidationError } from '../error/ValidationError';
import { TransactionError } from '../error/TransactionError';

import { Request } from "../handlers/Request";
import TemplateUtils from '../templates/TemplateUtils';
import { SovrinUtils } from '../crypto/SovrinUtils';
import mq from '../MessageQ';
import { IWalletModel } from "../model/project/Wallet";
import { AxiosResponse } from "axios";

import Cache from '../Cache';

var dateFormat = require('dateformat');

var wallet: IWalletModel;

export abstract class AbstractHandler {

  public dateTimeLogger() :string {
    return dateFormat(new Date(), "yyyy-mm-dd hh:mm:ss:l");
  }

  public createTransaction(args: any, method: string, model: Model<any>, checkIfExist?: Function, projectDid?: string) {

    var inst = this;
    var request = new Request(args);

    return new Promise((resolve: Function, reject: Function) => {
      if (connection.readyState != 1) {
        throw new TransactionError('Elysian not available');
      }
      if (!request.projectDid) request.projectDid = (projectDid || "");
      capabilitiesService.findCapabilitiesForProject(request.projectDid)
        .then((result: ICapabilitiesModel) => {
          var capabilityMap: any;
          result.capabilities.forEach(element => {
            if (element.capability == method) {
              capabilityMap = {
                capability: element.capability,
                template: element.template,
                allow: element.allow,
                validateKYC: element.validateKYC
              }
            }
          })
          return capabilityMap;
        }).catch((reason) => {
          console.log(this.dateTimeLogger() + ' capabilities not found for project' + request.projectDid);
          reject(new TransactionError('Capabilities not found for project'));
        })
        .then((capabilityMap: any) => {
          console.log(this.dateTimeLogger() + ' have capability ' + capabilityMap.capability);
          TemplateUtils.getTemplateFromCache(capabilityMap.template, request.template)
            .then((schema: any) => {
              console.log(this.dateTimeLogger() + ' validate the template');
              var validator: ValidatorResult;
              validator = validateJson(schema, args);
              if (validator.valid) {
                console.log(this.dateTimeLogger() + ' validate the capability');
                var capValid: RequestValidator;
                capValid = request.verifyCapability(capabilityMap.allow);
                if (capValid.valid) {
                  console.log(this.dateTimeLogger() + ' verify the signature');
                  request.verifySignature(this.preVerifyDidSignature.bind(this), capabilityMap.validateKYC, capabilityMap.capability)
                    .then((sigValid: RequestValidator) => {
                      if (sigValid.valid) {
                        console.log(this.dateTimeLogger() + ' signature verified');
                        if (mq.connection != null) {
                          if (checkIfExist) {
                            checkIfExist(request)
                              .then((found: boolean) => {
                                if (found) {
                                  reject(new TransactionError('Record out of date/already exists or state exception'));
                                } else {
                                  console.log(this.dateTimeLogger() + ' write transaction to log')
                                  transactionService.createTransaction(request.body, request.signature.type,
                                    request.signature.signatureValue, request.projectDid, capabilityMap.capability)
                                    .then((transaction: ITransactionModel) => {
                                      var obj = {
                                        ...request.data,
                                        txHash: transaction.hash,
                                        _creator: request.signature.creator,
                                        _created: request.signature.created,
                                        version: request.version + 1
                                      };
                                      console.log(this.dateTimeLogger() + ' updating the capabilities');
                                      this.updateCapabilities(request, capabilityMap.capability);
                                      console.log(this.dateTimeLogger() + ' commit to Elysian');
                                      resolve(model.create({ ...obj, projectDid: request.projectDid }));
                                      console.log(this.dateTimeLogger() + ' publish to blockchain');
                                      this.msgToPublish(obj, request, capabilityMap.capability)
                                        .then((msg: any) => {
                                          console.log(this.dateTimeLogger() + ' message to be published ' + msg.msgType);
                                          mq.publish(msg);
                                        });
                                      model.emit('postCommit', obj, request.projectDid);
                                      console.log(this.dateTimeLogger() + ' transaction completed successfully');
                                    });
                                }
                              })
                          } else {
                            console.log(this.dateTimeLogger() + ' write transaction to log');
                            transactionService.createTransaction(request.body, request.signature.type, request.signature.signatureValue,
                              request.projectDid, capabilityMap.capability)
                              .then((transaction: ITransactionModel) => {
                                var obj = {
                                  ...request.data,
                                  txHash: transaction.hash,
                                  _creator: request.signature.creator,
                                  _created: request.signature.created
                                };
                                console.log(this.dateTimeLogger() + ' updating the capabilities');
                                inst.updateCapabilities(request, capabilityMap.capability);
                                console.log(this.dateTimeLogger() + ' commit to Elysian');
                                resolve(model.create({ ...obj, projectDid: request.projectDid }));
                                console.log(this.dateTimeLogger() + ' publish to blockchain');
                                this.msgToPublish(obj, request, capabilityMap.capability)
                                  .then((msg: any) => {
                                    console.log(this.dateTimeLogger() + ' message to be published ' + msg.msgType);
                                    mq.publish(msg);
                                  });
                                model.emit('postCommit', obj, request.projectDid);
                                console.log(this.dateTimeLogger() + ' transaction completed successfully');
                              });
                          }
                        } else {
                          console.log(this.dateTimeLogger() + ' mq currently unavailable');
                          reject(new TransactionError('mq currently unavailable'));
                        }
                      } else {
                        reject(new ValidationError(sigValid.errors[0]));
                      }
                    })
                } else {
                  reject(new ValidationError(capValid.errors[0]));
                }
              } else {
                reject(new ValidationError(validator.errors[0].message));
              };
            })
            .catch((reason) => {
              console.log(this.dateTimeLogger() + 'template registry failed' + reason);
              reject(new TransactionError('Cannot connect to template registry'));
            });
        });
    });
  }

  public queryTransaction(args: any, method: string, query: Function) {
    var inst = this;
    var request = new Request(args);
    return new Promise((resolve: Function, reject: Function) => {
      capabilitiesService.findCapabilitiesForProject(request.projectDid)
        .then((result: ICapabilitiesModel) => {
          var capabilityMap: any;
          result.capabilities.forEach(element => {
            if (element.capability == method) {
              capabilityMap = {
                capability: element.capability,
                template: element.template,
                allow: element.allow
              }
            }
          })
          return capabilityMap;
        }).catch((reason) => {
          console.log(this.dateTimeLogger() + 'capabilities not found for project' + request.projectDid);
          reject(new TransactionError('Capabilities not found for project'));
        })
        .then((capabilityMap: any) => {
          console.log(this.dateTimeLogger() + ' have capability ' + capabilityMap.capability);
          TemplateUtils.getTemplateFromCache(capabilityMap.template, request.template)
            .then((schema: any) => {
              console.log(this.dateTimeLogger() + ' validate the template');
              var validator: ValidatorResult;
              validator = validateJson(schema, args);
              if (validator.valid) {
                console.log(this.dateTimeLogger() + ' validate the capability');
                var capValid: RequestValidator;
                capValid = request.verifyCapability(capabilityMap.allow);
                if (capValid.valid) {
                  console.log(this.dateTimeLogger() + ' verify the signature');
                  request.verifySignature(this.preVerifyDidSignature.bind(this), capabilityMap.validateKYC, capabilityMap.capability)
                    .then((sigValid: RequestValidator) => {
                      if (sigValid.valid) {
                        console.log(this.dateTimeLogger() + ' query Elysian');
                        resolve(query(request.data));
                      } else {
                        reject(new ValidationError(sigValid.errors[0]));
                      }
                      console.log(this.dateTimeLogger() + ' transaction completed successfully');
                    })
                } else {
                  reject(new ValidationError(capValid.errors[0]));
                }
              } else {
                reject(new ValidationError(validator.errors[0].message));
              };
            })
            .catch((reason) => {
              console.log(this.dateTimeLogger() + 'template registry failed' + reason);
              reject(new TransactionError('Cannot connect to template registry'));
            });
        });
    });
  }


  preVerifyDidSignature(didResponse: AxiosResponse, data: Request, capability: string): boolean {
    return true;
  }

  addCapabilities(projectDid: string, did: string, requestType: string) {
    capabilitiesService.addCapabilities(projectDid, did, requestType);
  }

  removeCapabilities(projectDid: string, did: string, requestType: string) {
    capabilitiesService.removeCapabilities(projectDid, did, requestType);
  }

  generateProjectWallet(): Promise<string> {
    return new Promise((resolve: Function, reject: Function) => {
      if (connection.readyState != 1) {
        throw new TransactionError('Elysian not available');
      }
      var sovrinUtils = new SovrinUtils();
      var mnemonic = sovrinUtils.generateBip39Mnemonic();
      var sovrinWallet = sovrinUtils.generateSdidFromMnemonic(mnemonic);
      var did = String("did:ixo:" + sovrinWallet.did);
      walletService.createWallet(did, sovrinWallet.secret.signKey, sovrinWallet.verifyKey)
        .then((resp: IWalletModel) => {
          wallet = resp;
          Cache.set(wallet.did, { publicKey: wallet.verifyKey });
          console.log(this.dateTimeLogger() + ' project wallet created');
          resolve(wallet.did);
        });
    });
  }

  abstract updateCapabilities(request: Request, methodCall: string): void;

  abstract msgToPublish(obj: any, request: Request, methodCall: string): any;

  getWallet(): IWalletModel {
    return wallet;
  }

  signMessageForBlockchain(msgToSign: any, projectDid: string) {
    return new Promise((resolve: Function, reject: Function) => {
      walletService.getWallet(projectDid)
        .then((wallet: IWalletModel) => {
          var sovrinUtils = new SovrinUtils();
          var signedMsg = {
            ...msgToSign,
            signature: {
              signatureValue: [1, sovrinUtils.signDocumentNoEncoding(wallet.signKey, wallet.verifyKey, wallet.did, msgToSign.payload[1])],
              created: new Date()
            }
          }
          let message = {
            msgType: 'blockchain',
            projectDid: wallet.did,
            data: new Buffer(JSON.stringify(signedMsg)).toString('hex')
          }
          resolve(message);
        });
    });
  }

  selfSignMessage(msgToSign: any, projectDid: string) {
    return new Promise((resolve: Function, reject: Function) => {
      walletService.getWallet(projectDid)
        .then((wallet: IWalletModel) => {
          Cache.set(wallet.did, { publicKey: wallet.verifyKey });
          var sovrinUtils = new SovrinUtils();
          resolve(sovrinUtils.signDocumentNoEncoding(wallet.signKey, wallet.verifyKey, wallet.did, msgToSign));
        });
    });
  }

  async publishMessageToQueue(message: any) {
    return new Promise((resolve: Function, reject: Function) => {
      console.log(this.dateTimeLogger() + ' message to be published ' + message.msgType);      
      resolve(mq.publish(message));
    });
  }

  subscribeToMessageQueue() {
    return new Promise((resolve: Function, reject: Function) => {
      resolve(mq.subscribe());
    });
  }
}