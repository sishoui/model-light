import { Inject, Injectable } from '@nestjs/common';
import { WxGateway } from '../auth/auth.service';

const CODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session';

/** Calls WeChat auth.code2session. Errors surface as AUTH_INVALID upstream. */
@Injectable()
export class WxHttpGateway implements WxGateway {
  constructor(
    @Inject('WX_APPID') private readonly appid: string,
    @Inject('WX_SECRET') private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async code2session(code: string): Promise<{ openid: string }> {
    const url = `${CODE2SESSION_URL}?appid=${encodeURIComponent(this.appid)}&secret=${encodeURIComponent(this.secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const res = await this.fetchImpl(url);
    const body = (await res.json()) as { openid?: string; errcode?: number; errmsg?: string };
    if (!body.openid) {
      throw new Error(`code2session failed: ${body.errcode ?? res.status}`);
    }
    return { openid: body.openid };
  }
}
