import { GitUtils } from './GitUtils';
import { Validator } from 'jsonschema';
import Cache from '../Cache';

var dateFormat = require('dateformat');

export class TemplateUtils {

  gitUtils: GitUtils

  constructor() {
    this.gitUtils = new GitUtils();
  }

  dateTimeLogger(): string {
    return dateFormat(new Date(), "yyyy-mm-dd hh:mm:ss:l");
  }

  getTemplateFromCache(templateType: string, name: string): Promise<string> {
    return new Promise((resolve: Function, reject: Function) => {
      var key = this.getCacheKey(templateType, name);
      Cache.get(key)
        .then((template: string) => {
          if (template) {
            // cache-hit
            console.log(this.dateTimeLogger() + ' got cache record for key ' + key);
            resolve(template);
          } else {
            resolve(this.getTemplateFromRegistry(templateType, name));
          }
        })
        .catch((reason) => {
          // cannot connect to cache; cache-miss
          console.log(this.dateTimeLogger() + ' template registry failed ' + reason);
          resolve(this.getTemplateFromRegistry(templateType, name));
        });
    });
  }

  getTemplateFromRegistry(templateType: string, name: string): any {
    var template = this.constructTemplate(templateType, name);
    console.log(this.dateTimeLogger() + ' load template contents from file');
    return this.gitUtils.loadFileContents(template)
      .then((templateContents: any) => {
        var res = JSON.parse(templateContents);
        var key = this.getCacheKey(templateType, name);
        Cache.set(key, res);
        return res;
      });
  }



  getCacheKey(templateType: string, name: string): string {
    return (templateType + "|" + name).toString();
  }

  validateData(data: any, schema: any) {
    var validator = new Validator();
    return validator.validate(data, schema).valid;
  }

  // Utilities
  constructTemplate(templateType: string, name: string) {
    return "/" + templateType + "/" + name + ".json";
  }

}

export default new TemplateUtils();