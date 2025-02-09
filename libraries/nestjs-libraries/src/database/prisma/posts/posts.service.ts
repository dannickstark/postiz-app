import { Injectable } from '@nestjs/common';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import dayjs from 'dayjs';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { Integration, Post, Media, From } from '@prisma/client';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { capitalize, shuffle, uniq } from 'lodash';
import { MessagesService } from '@gitroom/nestjs-libraries/database/prisma/marketplace/messages.service';
import { StripeService } from '@gitroom/nestjs-libraries/services/stripe.service';
import { CreateGeneratedPostsDto } from '@gitroom/nestjs-libraries/dtos/generator/create.generated.posts.dto';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import {
  BadBody,
  RefreshToken,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';
import { timer } from '@gitroom/helpers/utils/timer';
import { AuthTokenDetails } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import utc from 'dayjs/plugin/utc';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { ShortLinkService } from '@gitroom/nestjs-libraries/short-linking/short.link.service';
import { WebhooksService } from '@gitroom/nestjs-libraries/database/prisma/webhooks/webhooks.service';
import { CreateTagDto } from '@gitroom/nestjs-libraries/dtos/posts/create.tag.dto';
dayjs.extend(utc);

type PostWithConditionals = Post & {
  integration?: Integration;
  childrenPost: Post[];
};

@Injectable()
export class PostsService {
  constructor(
    private _postRepository: PostsRepository,
    private _workerServiceProducer: BullMqClient,
    private _integrationManager: IntegrationManager,
    private _notificationService: NotificationService,
    private _messagesService: MessagesService,
    private _stripeService: StripeService,
    private _integrationService: IntegrationService,
    private _mediaService: MediaService,
    private _shortLinkService: ShortLinkService,
    private _webhookService: WebhooksService
  ) {}

  async getStatistics(orgId: string, id: string) {
    const getPost = await this.getPostsRecursively(id, true, orgId, true);
    const content = getPost.map((p) => p.content);
    const shortLinksTracking = await this._shortLinkService.getStatistics(
      content
    );

    return {
      clicks: shortLinksTracking,
    };
  }

  async getPostsRecursively(
    id: string,
    includeIntegration = false,
    orgId?: string,
    isFirst?: boolean
  ): Promise<PostWithConditionals[]> {
    const post = await this._postRepository.getPost(
      id,
      includeIntegration,
      orgId,
      isFirst
    );

    if (!post) {
      return [];
    }

    return [
      post!,
      ...(post?.childrenPost?.length
        ? await this.getPostsRecursively(
            post?.childrenPost?.[0]?.id,
            false,
            orgId,
            false
          )
        : []),
    ];
  }

  getPosts(orgId: string, query: GetPostsDto) {
    return this._postRepository.getPosts(orgId, query);
  }

  async updateMedia(id: string, imagesList: any[]) {
    let imageUpdateNeeded = false;
    const getImageList = (
      await Promise.all(
        imagesList.map(async (p: any) => {
          if (!p.path && p.id) {
            imageUpdateNeeded = true;
            return this._mediaService.getMediaById(p.id);
          }

          return p;
        })
      )
    ).map((m) => {
      return {
        ...m,
        url:
          m.path.indexOf('http') === -1
            ? process.env.FRONTEND_URL +
              '/' +
              process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY +
              m.path
            : m.path,
        type: 'image',
        path:
          m.path.indexOf('http') === -1
            ? process.env.UPLOAD_DIRECTORY + m.path
            : m.path,
      };
    });

    if (imageUpdateNeeded) {
      await this._postRepository.updateImages(id, JSON.stringify(getImageList));
    }

    return getImageList;
  }

  async getPost(orgId: string, id: string) {
    const posts = await this.getPostsRecursively(id, true, orgId, true);
    const list = {
      group: posts?.[0]?.group,
      posts: await Promise.all(
        posts.map(async (post) => ({
          ...post,
          image: await this.updateMedia(
            post.id,
            JSON.parse(post.image || '[]')
          ),
        }))
      ),
      integrationPicture: posts[0]?.integration?.picture,
      integration: posts[0].integrationId,
      settings: JSON.parse(posts[0].settings || '{}'),
    };

    return list;
  }

  async getOldPosts(orgId: string, date: string) {
    return this._postRepository.getOldPosts(orgId, date);
  }

  async post(id: string) {
    const [firstPost, ...morePosts] = await this.getPostsRecursively(id, true);
    if (!firstPost) {
      return;
    }

    if (firstPost.integration?.refreshNeeded) {
      await this._notificationService.inAppNotification(
        firstPost.organizationId,
        `We couldn't post to ${firstPost.integration?.providerIdentifier} for ${firstPost?.integration?.name}`,
        `We couldn't post to ${firstPost.integration?.providerIdentifier} for ${firstPost?.integration?.name} because you need to reconnect it. Please enable it and try again.`,
        true
      );
      return;
    }

    if (firstPost.integration?.disabled) {
      await this._notificationService.inAppNotification(
        firstPost.organizationId,
        `We couldn't post to ${firstPost.integration?.providerIdentifier} for ${firstPost?.integration?.name}`,
        `We couldn't post to ${firstPost.integration?.providerIdentifier} for ${firstPost?.integration?.name} because it's disabled. Please enable it and try again.`,
        true
      );
      return;
    }

    try {
      const finalPost =
        firstPost.integration?.type === 'article'
          ? await this.postArticle(firstPost.integration!, [
              firstPost,
              ...morePosts,
            ])
          : await this.postSocial(firstPost.integration!, [
              firstPost,
              ...morePosts,
            ]);

      if (!finalPost?.postId || !finalPost?.releaseURL) {
        await this._postRepository.changeState(firstPost.id, 'ERROR');
        await this._notificationService.inAppNotification(
          firstPost.organizationId,
          `Error posting on ${firstPost.integration?.providerIdentifier} for ${firstPost?.integration?.name}`,
          `An error occurred while posting on ${firstPost.integration?.providerIdentifier}`,
          true
        );

        return;
      }

      if (firstPost.submittedForOrderId) {
        this._workerServiceProducer.emit('submit', {
          payload: {
            id: firstPost.id,
            releaseURL: finalPost.releaseURL,
          },
        });
      }
    } catch (err: any) {
      await this._postRepository.changeState(firstPost.id, 'ERROR', err);
      await this._notificationService.inAppNotification(
        firstPost.organizationId,
        `Error posting on ${firstPost.integration?.providerIdentifier} for ${firstPost?.integration?.name}`,
        `An error occurred while posting on ${
          firstPost.integration?.providerIdentifier
        } ${
          !process.env.NODE_ENV || process.env.NODE_ENV === 'development'
            ? err
            : ''
        }`,
        true
      );

      if (err instanceof BadBody) {
        console.error(
          '[Error] posting on',
          firstPost.integration?.providerIdentifier,
          err.identifier,
          err.json,
          err.body,
          err
        );

        return;
      }

      console.error(
        '[Error] posting on',
        firstPost.integration?.providerIdentifier,
        err
      );
    }
  }

  private async updateTags(orgId: string, post: Post[]): Promise<Post[]> {
    const plainText = JSON.stringify(post);
    const extract = Array.from(
      plainText.match(/\(post:[a-zA-Z0-9-_]+\)/g) || []
    );
    if (!extract.length) {
      return post;
    }

    const ids = extract.map((e) => e.replace('(post:', '').replace(')', ''));
    const urls = await this._postRepository.getPostUrls(orgId, ids);
    const newPlainText = ids.reduce((acc, value) => {
      const findUrl = urls?.find?.((u) => u.id === value)?.releaseURL || '';
      return acc.replace(
        new RegExp(`\\(post:${value}\\)`, 'g'),
        findUrl.split(',')[0]
      );
    }, plainText);

    return this.updateTags(orgId, JSON.parse(newPlainText) as Post[]);
  }

  private async postSocial(
    integration: Integration,
    posts: Post[],
    forceRefresh = false
  ): Promise<Partial<{ postId: string; releaseURL: string }>> {
    const getIntegration = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    if (!getIntegration) {
      return {};
    }

    if (dayjs(integration?.tokenExpiration).isBefore(dayjs()) || forceRefresh) {
      const { accessToken, expiresIn, refreshToken, additionalSettings } =
        await new Promise<AuthTokenDetails>((res) => {
          getIntegration
            .refreshToken(integration.refreshToken!)
            .then((r) => res(r))
            .catch(() =>
              res({
                accessToken: '',
                expiresIn: 0,
                refreshToken: '',
                id: '',
                name: '',
                username: '',
                picture: '',
                additionalSettings: undefined,
              })
            );
        });

      if (!accessToken) {
        await this._integrationService.refreshNeeded(
          integration.organizationId,
          integration.id
        );

        await this._integrationService.informAboutRefreshError(
          integration.organizationId,
          integration
        );
        return {};
      }

      await this._integrationService.createOrUpdateIntegration(
        additionalSettings,
        !!getIntegration.oneTimeToken,
        integration.organizationId,
        integration.name,
        integration.picture!,
        'social',
        integration.internalId,
        integration.providerIdentifier,
        accessToken,
        refreshToken,
        expiresIn
      );

      integration.token = accessToken;

      if (getIntegration.refreshWait) {
        await timer(10000);
      }
    }

    const newPosts = await this.updateTags(integration.organizationId, posts);

    try {
      const publishedPosts = await getIntegration.post(
        integration.internalId,
        integration.token,
        await Promise.all(
          newPosts.map(async (p) => ({
            id: p.id,
            message: p.content,
            settings: JSON.parse(p.settings || '{}'),
            media: await this.updateMedia(p.id, JSON.parse(p.image || '[]')),
          }))
        ),
        integration
      );

      for (const post of publishedPosts) {
        await this._postRepository.updatePost(
          post.id,
          post.postId,
          post.releaseURL
        );
      }

      await this._notificationService.inAppNotification(
        integration.organizationId,
        `Your post has been published on ${capitalize(
          integration.providerIdentifier
        )}`,
        `Your post has been published on ${capitalize(
          integration.providerIdentifier
        )} at ${publishedPosts[0].releaseURL}`,
        true,
        true
      );

      await this._webhookService.digestWebhooks(
        integration.organizationId,
        dayjs(newPosts[0].publishDate).format('YYYY-MM-DDTHH:mm:00')
      );

      await this.checkPlugs(
        integration.organizationId,
        getIntegration.identifier,
        integration.id,
        publishedPosts[0].postId
      );

      await this.checkInternalPlug(
        integration,
        integration.organizationId,
        publishedPosts[0].postId,
        JSON.parse(newPosts[0].settings || '{}')
      );

      return {
        postId: publishedPosts[0].postId,
        releaseURL: publishedPosts[0].releaseURL,
      };
    } catch (err) {
      if (err instanceof RefreshToken) {
        return this.postSocial(integration, posts, true);
      }

      throw err;
    }
  }

  private async checkInternalPlug(
    integration: Integration,
    orgId: string,
    id: string,
    settings: any
  ) {
    const plugs = Object.entries(settings).filter(([key]) => {
      return key.indexOf('plug-') > -1;
    });

    if (plugs.length === 0) {
      return;
    }

    const parsePlugs = plugs.reduce((all, [key, value]) => {
      const [_, name, identifier] = key.split('--');
      all[name] = all[name] || { name };
      all[name][identifier] = value;
      return all;
    }, {} as any);

    const list: {
      name: string;
      integrations: { id: string }[];
      delay: string;
      active: boolean;
    }[] = Object.values(parsePlugs);

    for (const trigger of list || []) {
      for (const int of trigger?.integrations || []) {
        this._workerServiceProducer.emit('internal-plugs', {
          id: 'plug_' + id + '_' + trigger.name + '_' + int.id,
          options: {
            delay: +trigger.delay,
          },
          payload: {
            post: id,
            originalIntegration: integration.id,
            integration: int.id,
            plugName: trigger.name,
            orgId: orgId,
            delay: +trigger.delay,
            information: trigger,
          },
        });
      }
    }
  }

  private async checkPlugs(
    orgId: string,
    providerName: string,
    integrationId: string,
    postId: string
  ) {
    const loadAllPlugs = this._integrationManager.getAllPlugs();
    const getPlugs = await this._integrationService.getPlugs(
      orgId,
      integrationId
    );

    const currentPlug = loadAllPlugs.find((p) => p.identifier === providerName);

    for (const plug of getPlugs) {
      const runPlug = currentPlug?.plugs?.find(
        (p: any) => p.methodName === plug.plugFunction
      )!;
      if (!runPlug) {
        continue;
      }

      this._workerServiceProducer.emit('plugs', {
        id: 'plug_' + postId + '_' + runPlug.identifier,
        options: {
          delay: runPlug.runEveryMilliseconds,
        },
        payload: {
          plugId: plug.id,
          postId,
          delay: runPlug.runEveryMilliseconds,
          totalRuns: runPlug.totalRuns,
          currentRun: 1,
        },
      });
    }
  }

  private async postArticle(integration: Integration, posts: Post[]) {
    const getIntegration = this._integrationManager.getArticlesIntegration(
      integration.providerIdentifier
    );
    if (!getIntegration) {
      return;
    }

    const newPosts = await this.updateTags(integration.organizationId, posts);

    const { postId, releaseURL } = await getIntegration.post(
      integration.token,
      newPosts.map((p) => p.content).join('\n\n'),
      JSON.parse(newPosts[0].settings || '{}')
    );

    await this._notificationService.inAppNotification(
      integration.organizationId,
      `Your article has been published on ${capitalize(
        integration.providerIdentifier
      )}`,
      `Your article has been published at ${releaseURL}`,
      true
    );
    await this._postRepository.updatePost(newPosts[0].id, postId, releaseURL);

    return {
      postId,
      releaseURL,
    };
  }

  async deletePost(orgId: string, group: string) {
    const post = await this._postRepository.deletePost(orgId, group);
    if (post?.id) {
      await this._workerServiceProducer.delete('post', post.id);
      return { id: post.id };
    }

    return { error: true };
  }

  async countPostsFromDay(orgId: string, date: Date) {
    return this._postRepository.countPostsFromDay(orgId, date);
  }

  async submit(
    id: string,
    order: string,
    message: string,
    integrationId: string
  ) {
    if (!(await this._messagesService.canAddPost(id, order, integrationId))) {
      throw new Error('You can not add a post to this publication');
    }
    const getOrgByOrder = await this._messagesService.getOrgByOrder(order);
    const submit = await this._postRepository.submit(
      id,
      order,
      getOrgByOrder?.messageGroup?.buyerOrganizationId!
    );
    const messageModel = await this._messagesService.createNewMessage(
      submit?.submittedForOrder?.messageGroupId || '',
      From.SELLER,
      '',
      {
        type: 'post',
        data: {
          id: order,
          postId: id,
          status: 'PENDING',
          integration: integrationId,
          description: message.slice(0, 300) + '...',
        },
      }
    );

    await this._postRepository.updateMessage(id, messageModel.id);

    return messageModel;
  }

  async createPost(orgId: string, body: CreatePostDto) {
    const postList = [];
    for (const post of body.posts) {
      const messages = post.value.map((p) => p.content);
      const updateContent = !body.shortLink
        ? messages
        : await this._shortLinkService.convertTextToShortLinks(orgId, messages);

      post.value = post.value.map((p, i) => ({
        ...p,
        content: updateContent[i],
      }));

      const { previousPost, posts } =
        await this._postRepository.createOrUpdatePost(
          body.type,
          orgId,
          body.type === 'now'
            ? dayjs().format('YYYY-MM-DDTHH:mm:00')
            : body.date,
          post,
          body.tags
        );

      if (!posts?.length) {
        return;
      }

      await this._workerServiceProducer.delete(
        'post',
        previousPost ? previousPost : posts?.[0]?.id
      );

      if (body.order && body.type !== 'draft') {
        await this.submit(
          posts[0].id,
          body.order,
          post.value[0].content,
          post.integration.id
        );
        continue;
      }

      if (
        body.type === 'now' ||
        (body.type === 'schedule' && dayjs(body.date).isAfter(dayjs()))
      ) {
        this._workerServiceProducer.emit('post', {
          id: posts[0].id,
          options: {
            delay:
              body.type === 'now'
                ? 0
                : dayjs(posts[0].publishDate).diff(dayjs(), 'millisecond'),
          },
          payload: {
            id: posts[0].id,
          },
        });
      }

      postList.push({
        postId: posts[0].id,
        integration: post.integration.id,
      });
    }

    return postList;
  }

  async changeDate(orgId: string, id: string, date: string) {
    const getPostById = await this._postRepository.getPostById(id, orgId);
    if (
      getPostById?.submittedForOrderId &&
      getPostById.approvedSubmitForOrder !== 'NO'
    ) {
      throw new Error(
        'You can not change the date of a post that has been submitted'
      );
    }

    await this._workerServiceProducer.delete('post', id);
    if (getPostById?.state !== 'DRAFT' && !getPostById?.submittedForOrderId) {
      this._workerServiceProducer.emit('post', {
        id: id,
        options: {
          delay: dayjs(date).diff(dayjs(), 'millisecond'),
        },
        payload: {
          id: id,
        },
      });
    }

    return this._postRepository.changeDate(orgId, id, date);
  }

  async payout(id: string, url: string) {
    const getPost = await this._postRepository.getPostById(id);
    if (!getPost || !getPost.submittedForOrder) {
      return;
    }

    const findPrice = getPost.submittedForOrder.ordersItems.find(
      (orderItem) => orderItem.integrationId === getPost.integrationId
    )!;

    await this._messagesService.createNewMessage(
      getPost.submittedForOrder.messageGroupId,
      From.SELLER,
      '',
      {
        type: 'published',
        data: {
          id: getPost.submittedForOrder.id,
          postId: id,
          status: 'PUBLISHED',
          integrationId: getPost.integrationId,
          integration: getPost.integration.providerIdentifier,
          picture: getPost.integration.picture,
          name: getPost.integration.name,
          url,
        },
      }
    );

    const totalItems = getPost.submittedForOrder.ordersItems.reduce(
      (all, p) => all + p.quantity,
      0
    );
    const totalPosts = getPost.submittedForOrder.posts.length;

    if (totalItems === totalPosts) {
      await this._messagesService.completeOrder(getPost.submittedForOrder.id);
      await this._messagesService.createNewMessage(
        getPost.submittedForOrder.messageGroupId,
        From.SELLER,
        '',
        {
          type: 'order-completed',
          data: {
            id: getPost.submittedForOrder.id,
            postId: id,
            status: 'PUBLISHED',
          },
        }
      );
    }

    try {
      await this._stripeService.payout(
        getPost.submittedForOrder.id,
        getPost.submittedForOrder.captureId!,
        getPost.submittedForOrder.seller.account!,
        findPrice.price
      );

      return this._notificationService.inAppNotification(
        getPost.integration.organizationId,
        'Payout completed',
        `You have received a payout of $${findPrice.price}`,
        true
      );
    } catch (err) {
      await this._messagesService.payoutProblem(
        getPost.submittedForOrder.id,
        getPost.submittedForOrder.seller.id,
        findPrice.price,
        id
      );
    }
  }

  async generatePostsDraft(orgId: string, body: CreateGeneratedPostsDto) {
    const getAllIntegrations = (
      await this._integrationService.getIntegrationsList(orgId)
    ).filter((f) => !f.disabled && f.providerIdentifier !== 'reddit');

    // const posts = chunk(body.posts, getAllIntegrations.length);
    const allDates = dayjs()
      .isoWeek(body.week)
      .year(body.year)
      .startOf('isoWeek');

    const dates = [...new Array(7)].map((_, i) => {
      return allDates.add(i, 'day').format('YYYY-MM-DD');
    });

    const findTime = (): string => {
      const totalMinutes = Math.floor(Math.random() * 144) * 10;

      // Convert total minutes to hours and minutes
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;

      // Format hours and minutes to always be two digits
      const formattedHours = hours.toString().padStart(2, '0');
      const formattedMinutes = minutes.toString().padStart(2, '0');
      const randomDate =
        shuffle(dates)[0] + 'T' + `${formattedHours}:${formattedMinutes}:00`;

      if (dayjs(randomDate).isBefore(dayjs())) {
        return findTime();
      }

      return randomDate;
    };

    for (const integration of getAllIntegrations) {
      for (const toPost of body.posts) {
        const group = makeId(10);
        const randomDate = findTime();

        await this.createPost(orgId, {
          type: 'draft',
          date: randomDate,
          order: '',
          shortLink: false,
          tags: [],
          posts: [
            {
              group,
              integration: {
                id: integration.id,
              },
              settings: {
                subtitle: '',
                title: '',
                tags: [],
                subreddit: [],
              },
              value: [
                ...toPost.list.map((l) => ({
                  id: '',
                  content: l.post,
                  image: [],
                })),
                {
                  id: '',
                  content: `Check out the full story here:\n${
                    body.postId || body.url
                  }`,
                  image: [],
                },
              ],
            },
          ],
        });
      }
    }
  }

  findAllExistingCategories() {
    return this._postRepository.findAllExistingCategories();
  }

  findAllExistingTopicsOfCategory(category: string) {
    return this._postRepository.findAllExistingTopicsOfCategory(category);
  }

  findPopularPosts(category: string, topic?: string) {
    return this._postRepository.findPopularPosts(category, topic);
  }

  async findFreeDateTime(orgId: string) {
    const findTimes = await this._integrationService.findFreeDateTime(orgId);
    return this.findFreeDateTimeRecursive(
      orgId,
      findTimes,
      dayjs.utc().startOf('day')
    );
  }

  async createPopularPosts(post: {
    category: string;
    topic: string;
    content: string;
    hook: string;
  }) {
    return this._postRepository.createPopularPosts(post);
  }

  private async findFreeDateTimeRecursive(
    orgId: string,
    times: number[],
    date: dayjs.Dayjs
  ): Promise<string> {
    const list = await this._postRepository.getPostsCountsByDates(
      orgId,
      times,
      date
    );

    if (!list.length) {
      return this.findFreeDateTimeRecursive(orgId, times, date.add(1, 'day'));
    }

    const num = list.reduce<null | number>((prev, curr) => {
      if (prev === null || prev > curr) {
        return curr;
      }
      return prev;
    }, null) as number;

    return date.clone().add(num, 'minutes').format('YYYY-MM-DDTHH:mm:00');
  }

  getComments(postId: string) {
    return this._postRepository.getComments(postId);
  }

  getTags(orgId: string) {
    return this._postRepository.getTags(orgId);
  }

  createTag(orgId: string, body: CreateTagDto) {
    return this._postRepository.createTag(orgId, body);
  }

  editTag(id: string, orgId: string, body: CreateTagDto) {
    return this._postRepository.editTag(id, orgId, body);
  }

  createComment(
    orgId: string,
    userId: string,
    postId: string,
    comment: string
  ) {
    return this._postRepository.createComment(orgId, userId, postId, comment);
  }

  async sendDigestEmail(subject: string, orgId: string, since: string) {
    const getNotificationsForOrgSince =
      await this._notificationService.getNotificationsSince(orgId, since);
    if (getNotificationsForOrgSince.length === 0) {
      return;
    }

    const message = getNotificationsForOrgSince
      .map((p) => p.content)
      .join('<br />');
    await this._notificationService.sendEmailsToOrg(
      orgId,
      getNotificationsForOrgSince.length === 1
        ? subject
        : '[Postiz] Your latest notifications',
      message
    );
  }
}
