'use strict';

import utils from './../utils.js';
import buildURL from '../helpers/buildURL.js';
import InterceptorManager from './InterceptorManager.js';
import dispatchRequest from './dispatchRequest.js';
import mergeConfig from './mergeConfig.js';
import buildFullPath from './buildFullPath.js';
import validator from '../helpers/validator.js';
import AxiosHeaders from './AxiosHeaders.js';

const validators = validator.validators;

/**
 * 创建一个新的Axios实例
 * @param {Object} instanceConfig 实例的默认配置
 */
class Axios {
  constructor(instanceConfig) {
    // 保存默认配置
    this.defaults = instanceConfig;
    // 创建请求和响应的拦截器管理器
    this.interceptors = {
      request: new InterceptorManager(),
      response: new InterceptorManager()
    };
  }

  /**
   * 发送请求的主要方法
   * 这是一个包装方法，主要用于处理错误的堆栈跟踪
   */
  async request(configOrUrl, config) {
    try {
      return await this._request(configOrUrl, config);
    } catch (err) {
      if (err instanceof Error) {
        let dummy;

        Error.captureStackTrace ? Error.captureStackTrace(dummy = {}) : (dummy = new Error());

        // slice off the Error: ... line
        const stack = dummy.stack ? dummy.stack.replace(/^.+\n/, '') : '';
        try {
          if (!err.stack) {
            err.stack = stack;
            // match without the 2 top stack lines
          } else if (stack && !String(err.stack).endsWith(stack.replace(/^.+\n.+\n/, ''))) {
            err.stack += '\n' + stack
          }
        } catch (e) {
          // ignore the case where "stack" is an un-writable property
        }
      }

      throw err;
    }
  }

  /**
   * 请求的核心方法，处理请求配置和拦截器链
   * @param {String|Object} configOrUrl 请求配置或URL字符串
   * @param {Object} config 当configOrUrl为字符串时的配置对象
   */
  _request(configOrUrl, config) {
    /*eslint no-param-reassign:0*/
    // Allow for axios('example/url'[, config]) a la fetch API
    /**
     * 如果configOrUrl是字符串，则将config赋值给configOrUrl
     * 否则，将config赋值给configOrUrl
     */
    if (typeof configOrUrl === 'string') {
      config = config || {};
      config.url = configOrUrl;
    } else {
      config = configOrUrl || {};
    }
    // merge一下所有的配置
    config = mergeConfig(this.defaults, config);
    // 获取配置中的some config
    const {transitional, paramsSerializer, headers} = config;
    // 对transitional 校验一下
    if (transitional !== undefined) {
      validator.assertOptions(transitional, {
        silentJSONParsing: validators.transitional(validators.boolean),
        forcedJSONParsing: validators.transitional(validators.boolean),
        clarifyTimeoutError: validators.transitional(validators.boolean)
      }, false);
    }

    if (paramsSerializer != null) {
      if (utils.isFunction(paramsSerializer)) {
        config.paramsSerializer = {
          serialize: paramsSerializer
        }
      } else {
        validator.assertOptions(paramsSerializer, {
          encode: validators.function,
          serialize: validators.function
        }, true);
      }
    }

    // Set config.method
    // 设置配置方法
    config.method = (config.method || this.defaults.method || 'get').toLowerCase();

    // Flatten headers
    let contextHeaders = headers && utils.merge(
      headers.common,
      headers[config.method]
    );

    headers && utils.forEach(
      ['delete', 'get', 'head', 'post', 'put', 'patch', 'common'],
      (method) => {
        delete headers[method];
      }
    );

    config.headers = AxiosHeaders.concat(contextHeaders, headers);

    // 创建拦截器链
    const requestInterceptorChain = [];
    let synchronousRequestInterceptors = true;
    
    // 处理请求拦截器
    this.interceptors.request.forEach(function unshiftRequestInterceptors(interceptor) {
      // 检查拦截器是否应该运行
      if (typeof interceptor.runWhen === 'function' && interceptor.runWhen(config) === false) {
        return;
      }

      // 检查是否所有请求拦截器都是同步的
      synchronousRequestInterceptors = synchronousRequestInterceptors && interceptor.synchronous;

      // 将拦截器添加到链的开头
      requestInterceptorChain.unshift(interceptor.fulfilled, interceptor.rejected);
    });

    // 处理响应拦截器
    const responseInterceptorChain = [];
    this.interceptors.response.forEach(function pushResponseInterceptors(interceptor) {
      responseInterceptorChain.push(interceptor.fulfilled, interceptor.rejected);
    });

    let promise;
    let i = 0;
    let len;

    // 异步拦截器的处理逻辑
    if (!synchronousRequestInterceptors) {
      // 创建完整的处理链：请求拦截器 -> 请求发送 -> 响应拦截器
      const chain = [dispatchRequest.bind(this), undefined];
      chain.unshift.apply(chain, requestInterceptorChain);
      chain.push.apply(chain, responseInterceptorChain);
      len = chain.length;

      promise = Promise.resolve(config);

      // 通过Promise链式调用执行所有拦截器
      while (i < len) {
        promise = promise.then(chain[i++], chain[i++]);
      }

      return promise;
    }

    // 同步拦截器的处理逻辑
    len = requestInterceptorChain.length;
    let newConfig = config;
    i = 0;

    // 同步执行请求拦截器
    while (i < len) {
      const onFulfilled = requestInterceptorChain[i++];
      const onRejected = requestInterceptorChain[i++];
      try {
        newConfig = onFulfilled(newConfig);
      } catch (error) {
        onRejected.call(this, error);
        break;
      }
    }

    // 发送请求
    try {
      promise = dispatchRequest.call(this, newConfig);
    } catch (error) {
      return Promise.reject(error);
    }

    // 执行响应拦截器
    i = 0;
    len = responseInterceptorChain.length;
    while (i < len) {
      promise = promise.then(responseInterceptorChain[i++], responseInterceptorChain[i++]);
    }

    return promise;
  }

  /**
   * 获取完整的URL
   * @param {Object} config 请求配置
   * @returns {String} 完整的URL
   */
  getUri(config) {
    config = mergeConfig(this.defaults, config);
    const fullPath = buildFullPath(config.baseURL, config.url);
    return buildURL(fullPath, config.params, config.paramsSerializer);
  }
}

// 为不需要请求体的HTTP方法创建别名（delete, get, head, options）
utils.forEach(['delete', 'get', 'head', 'options'], function forEachMethodNoData(method) {
  /*eslint func-names:0*/
  Axios.prototype[method] = function(url, config) {
    return this.request(mergeConfig(config || {}, {
      method,
      url,
      data: (config || {}).data
    }));
  };
});

// 为需要请求体的HTTP方法创建别名（post, put, patch）
// 同时创建对应的Form方法，用于发送multipart/form-data请求
utils.forEach(['post', 'put', 'patch'], function forEachMethodWithData(method) {
  /*eslint func-names:0*/

  function generateHTTPMethod(isForm) {
    return function httpMethod(url, data, config) {
      return this.request(mergeConfig(config || {}, {
        method,
        headers: isForm ? {
          'Content-Type': 'multipart/form-data'
        } : {},
        url,
        data
      }));
    };
  }

  Axios.prototype[method] = generateHTTPMethod();

  Axios.prototype[method + 'Form'] = generateHTTPMethod(true);
});

export default Axios;
