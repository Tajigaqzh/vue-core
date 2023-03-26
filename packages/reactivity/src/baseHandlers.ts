import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly,
  isShallow
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

//   /*#__PURE__*/用于告诉rollup如果该内容没有被使用，则会被tree-shaking

//不被追踪的keys
const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*#__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

/**
* arrayInstrumentations：要特殊处理的数组方法：
* includes、indexOf、lastIndexOf
* push、pop、shift、unshift、splice。
* 以push为例，ECMAScript当向arr中进行push操作，首先读取到arr.length，将length对应的依赖effect收集起来，
* 由于push操作会设置length，所以在设置length的过程中会触发length的依赖(执行effect.run())，
* 而在effect.run()中会执行this.fn()，又会调用arr.push操作，这样就会造成一个死循环。

* 为了解决这两个问题，需要重写这几个方法
 */
function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive values
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      //转换为raw对象
      const arr = toRaw(this) as any
      for (let i = 0, l = this.length; i < l; i++) {
        // 每个索引都需要进行收集依赖
        track(arr, TrackOpTypes.GET, i + '')
      }
      // 在原始对象上调用方法
      // we run the method using the original args first (which may be reactive)
      const res = arr[key](...args)
      // 如果没有找到，可能参数中有响应对象，将参数转为原始对象，再调用方法
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 暂停依赖收集
      // 因为push等操作是修改数组的，所以在push过程中不进行依赖的收集是合理的，只要它能够触发依赖就可以
      pauseTracking()
      const res = (toRaw(this) as any)[key].apply(this, args)
      resetTracking()
      return res
    }
  })
  return instrumentations
}
/**
 * 是否有独特的属性
 * @returns boolean
 * */
function hasOwnProperty(this: object, key: string) {
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key)
}
/**
 * getter拦截方法
 * get捕获器为属性读取操作的捕获器，
 * 它可以捕获obj.pro、array[index]、
 * array.indexOf()、arr.length、
 * Reflect.get()、Object.create(obj).foo（访问继承者的属性）等操作。
 * @param isReadonly 是否是只读
 * @param shallow 是否是浅层次，默认为否
 * @returns 返回get()函数
 * 在get捕获器中，会先处理几个特殊的key：
  ReactiveFlags.IS_REACTIVE：是不是reactive
  ReactiveFlags.IS_READONLY：是不是只读的
  ReactiveFlags.IS_SHALLOW：是不是浅层响应式
  ReactiveFlags.RAW：原始值
 */
function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {
    //如果对象的key是reactive对象
    if (key === ReactiveFlags.IS_REACTIVE) {
      //返回true
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      //如果key是只读，返回false
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      //如果是shallow返回false
      return shallow
    } else if (
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
        //判断是否是shallow,是否是shallow分别从对应map中取值
        // 在获取原始值，有个额外的条件：receiver全等于target的代理对象。这样做是为了避免从原型链上获取不属于自己的原始对象

    
    ) {
      return target
    }

    const targetIsArray = isArray(target)
    //如果不是只读
    if (!isReadonly) {
      //是array且有自己自定义的
      if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
      // 使用reflect.get()获取值
        return Reflect.get(arrayInstrumentations, key, receiver)
      }

      //如果key有自己独特的属性返回boolean（是否有独特属性）
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }

    //处理完数组的几个特殊方法后，会使用Reflect.get获取结果res
    const res = Reflect.get(target, key, receiver)

    //如果res是symbol类型，并且key是Symbol内置的值，直接返回res；
    //如果res不是symbol类型，且key不再__proto__（避免对原型进行依赖追踪）、__v_isRef、__isVue中。
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    if (!isReadonly) {
      //如果不是只读的，追踪。追踪类型get，追踪key
      track(target, TrackOpTypes.GET, key)
    }

    //如果是浅层次的，直接返回
    if (shallow) {
      return res
    }

    //获取到的res如果是ref
    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      //判断key是否是array，是否是integer，是的话直接返回，不是返回.value
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    /**
     * res如果是对象，且对象没有被设置成readonly，进行深层次reactive代理
     */
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      //将返回的值也转换为proxy。我们在这里进行isObject检查，以避免无效值警告。
      //这里还需要延迟访问readonly和reactive，以避免循环依赖。
      
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)
/**
 * setter拦截方法
 * @param shallow 是否浅层次拦截，默认为false
 * @returns set():boolean函数
 */
function createSetter(shallow = false) {
  return function set(
    target: object,//对象
    key: string | symbol,//对象键
    value: unknown,//对象值
    receiver: object//拦截器
  ): boolean {
    //获取旧值
    let oldValue = (target as any)[key]
    //如果旧值是只读，旧值是ref且新值不是ref
    //&&第一个条件不满足，后面条件就不再判断。
    if (isReadonly(oldValue) && isRef(oldValue) && !isRef(value)) {
      return false
    }
    //深层次的
    if (!shallow) {
      //如果新值不是浅层次且不是只读
      if (!isShallow(value) && !isReadonly(value)) {
        //oldvalue变成原始对象，重新赋值
        oldValue = toRaw(oldValue)
        //新值变成原始对象直接复制
        value = toRaw(value)
      }
      //如果不是数组，且旧值是ref，新值不是ref
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
    //浅层次的，对象被设置为原样，而不考虑是否有reactive
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    //传入的target是数组或者key是数字
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    //通过Reflect.set()设置
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    //如果目标是原始原型链中的某个东西，则不要触发
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        //触发依赖，add
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        //触发依赖，set
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  //使用reflect进行操作
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) {
    //触发依赖
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}
/**
 * 判断是否有key
 * @param target 判断的对象
 * @param key key
 * @returns boolean
 */
function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

function ownKeys(target: object): (string | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

//用于object，array类拦截
export const mutableHandlers: ProxyHandler<object> = {
  get,// 用于拦截对象的读取属性操作
  set,// 用于拦截对象的设置属性操作
  deleteProperty,// 用于拦截对象的删除属性操作
  has,// 检查一个对象是否拥有某个属性
  ownKeys// 针对 getOwnPropertyNames,  getOwnPropertySymbols, keys 的代理方法
  /* 
    get has ownKeys 会触发依赖收集 track()
    set deleteProperty 会触发更新 trigger()
  */
}

/**
 * readonly拦截方法
 */
export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
