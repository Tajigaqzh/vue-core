import { DebuggerOptions, ReactiveEffect } from './effect'
import { Ref, trackRefValue, triggerRefValue } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'
import { Dep } from './dep'

declare const ComputedRefSymbol: unique symbol

/**
 * ComputedRef的value只读
 */
export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
  [ComputedRefSymbol]: true
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (...args: any[]) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

/**
 * ComputedRefImpl
 * @param getters
 * @param setter
 * @param isReadonly
 * @param isSSR
 */
export class ComputedRefImpl<T> {
  //依赖关系类，可选
  public dep?: Dep = undefined
  
  // 缓存的值
  private _value!: T
  
  // 在构造器中创建的ReactiveEffect实例
  public readonly effect: ReactiveEffect<T>

  //标记为一个ref类型
  public readonly __v_isRef = true
  
   // 只读标识
  public readonly [ReactiveFlags.IS_READONLY]: boolean = false

  // 是否为脏数据，如果是脏数据需要重新计算
  public _dirty = true

  // 是否可缓存，取决于SSR
  public _cacheable: boolean

  constructor(
    //getter
    getter: ComputedGetter<T>,
    //setter，只读
    private readonly _setter: ComputedSetter<T>,
    isReadonly: boolean,
    isSSR: boolean
  ) {
    //在构造器中声明了一个ReactiveEffect，并将getter和一个调度函数作为参数传入，
    //在调度器中如果_dirty为false，会将_dirty设置为true，并执行triggerRefValue函数。
    this.effect = new ReactiveEffect(getter, () => {
      if (!this._dirty) {
        this._dirty = true
        //有脏数据触发依赖收集
        triggerRefValue(this)
      }
    })
    //把ComputedRefImpl实例指向到给副作用的computed
    this.effect.computed = this
    this.effect.active = this._cacheable = !isSSR
    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  get value() {
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    //// computed可能被其他proxy包裹，如readonly(computed(() => foo.bar))，所以要获取this的原始对象
    const self = toRaw(this)
    //收集依赖
    trackRefValue(self)
    /*
    * 根据_dirty与_cacheable属性来决定是否需要修改self._value，
    * 其中_dirty表示是否为脏数据，
    * _cacheable表示是否可以缓存（取决于是否为服务端渲染，如果为服务端渲染则不可以缓存）。
    * 如果是脏数据或不可以被缓存，那么会将_dirty设置为false，
    * 并调用self.effect.run()，修改self._value。
    */
    if (self._dirty || !self._cacheable) {
      // _dirty取false，防止依赖不变重复计算
      self._dirty = false
      //计算并重新赋值_value
      self._value = self.effect.run()!
      //尾部！：使null和undefined类型可以赋值给其他类型并通过编译，表示该变量值可空
    }
    return self._value
  }

  //当修改ComputedRefImpl实例的value属性时，会调用实例的_setter函数。
  set value(newValue: T) {
    this._setter(newValue)
  }
}

export function computed<T>(
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions
): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
): WritableComputedRef<T>
/**
 * computed是懒惰的，只有使用到computed的返回结果，才能触发相关计算。
 * @param getterOrOptions  一种是一个getter函数，一种是个包含get、set的对象。
 * @param debugOptions (可选)依赖收集和触发依赖的钩子函数
 * @param isSSR 是否是SSR
 * @returns 
 */
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions,
  isSSR = false
) {
  //定义setter和setter
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  //判断getterOrOptions是否是函数
  const onlyGetter = isFunction(getterOrOptions)

  if (onlyGetter) {
    //如果为true，则computed不可写，将setter设置为空函数
    //把getterOrOptions赋值给getter
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    //否则赋值getter和setter
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  //创建ComputedRefImpl
  const cRef = new ComputedRefImpl(getter, setter, onlyGetter || !setter, isSSR)

  if (__DEV__ && debugOptions && !isSSR) {
    cRef.effect.onTrack = debugOptions.onTrack
    cRef.effect.onTrigger = debugOptions.onTrigger
  }

  return cRef as any
}
