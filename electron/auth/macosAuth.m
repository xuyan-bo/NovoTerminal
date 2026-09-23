#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <dispatch/dispatch.h>
#include <stdio.h>
#include <stdlib.h>

static void outputResult(const char *result) {
  puts(result);
  fflush(stdout);
  exit(EXIT_SUCCESS);
}

static const char *resultForError(NSError *error) {
  if (![error.domain isEqualToString:LAErrorDomain]) return "Failed";

  switch (error.code) {
    case LAErrorUserCancel:
    case LAErrorSystemCancel:
    case LAErrorAppCancel:
    case LAErrorUserFallback:
      return "Canceled";
    case LAErrorAuthenticationFailed:
      return "BadCredentials";
    case LAErrorBiometryLockout:
      return "RetriesExhausted";
    case LAErrorPasscodeNotSet:
    case LAErrorBiometryNotAvailable:
    case LAErrorBiometryNotEnrolled:
    case LAErrorNotInteractive:
      return "Unavailable";
    default:
      return "Failed";
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) outputResult("Failed");

    NSString *reason = [[NSString alloc] initWithUTF8String:argv[1]];
    if (!reason || [reason stringByTrimmingCharactersInSet:
        [NSCharacterSet whitespaceAndNewlineCharacterSet]].length == 0) {
      outputResult("Failed");
    }

    LAContext *context = [[LAContext alloc] init];
    NSTimeInterval deadline = [NSProcessInfo processInfo].systemUptime + 120.0;
    __block BOOL completed = NO;
    void (^complete)(const char *) = ^(const char *result) {
      if (completed) return;
      completed = YES;
      const char *finalResult = [NSProcessInfo processInfo].systemUptime >= deadline
        ? "TimedOut" : result;
      [context invalidate];
      outputResult(finalResult);
    };

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 120LL * NSEC_PER_SEC),
      dispatch_get_main_queue(), ^{
        complete("TimedOut");
      });

    dispatch_async(dispatch_get_main_queue(), ^{
      NSError *error = nil;
      if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) {
        complete(resultForError(error));
        return;
      }
      if ([NSProcessInfo processInfo].systemUptime >= deadline) {
        complete("TimedOut");
        return;
      }
      [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
              localizedReason:reason
                        reply:^(BOOL success, NSError *evaluationError) {
        dispatch_async(dispatch_get_main_queue(), ^{
          complete(success ? "Verified" : resultForError(evaluationError));
        });
      }];
    });

    dispatch_main();
  }
}
